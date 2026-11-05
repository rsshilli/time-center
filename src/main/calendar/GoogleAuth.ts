import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Read-only access to calendars: enough to see meetings and their links, nothing more. */
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

/** Google's sign-in page and token endpoint for installed apps. */
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** How long the sign-in page may stay open before the app stops waiting for it. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** Renew an access token this long before Google says it expires. */
const EXPIRY_MARGIN_MS = 60_000;

/** The names the client and the refresh token are kept under in the SecretStore. */
const CLIENT_SECRET_NAME = "google.client";
const REFRESH_TOKEN_SECRET_NAME = "google.refreshToken";

/** A Google OAuth client: the app's ID card with Google, from a credentials.json file. */
export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

/** What sign-in needs, injected so tests run without Electron, a browser or Google. */
export interface GoogleAuthDeps {
  secrets: { get(name: string): string | null; set(name: string, value: string | null): void };
  /** The Time Center client built into the app, or null for a build made without one. */
  builtInClient: GoogleClient | null;
  /** Opens Google's sign-in page in the browser. */
  openExternal(url: string): Promise<void>;
  fetch: typeof fetch;
  now(): number;
}

/**
 * Signs in to Google for read-only calendar access, the way Google asks desktop apps to: the browser shows
 * Google's own sign-in page, which hands a one-time code back to a short-lived server on 127.0.0.1, and the
 * app swaps it for tokens (with PKCE, so an intercepted code is useless). Only the long-lived refresh
 * token is kept, encrypted with the Keychain key; access tokens live in memory for their hour.
 */
export class GoogleAuth {
  private accessToken: { value: string; expiresAt: number } | null = null;

  /** @param deps Secrets, the browser, the network and the clock. */
  constructor(private readonly deps: GoogleAuthDeps) {}

  /**
   * Reads a credentials.json file downloaded from Google Cloud and keeps the client in it.
   * @param fileText The file's contents.
   */
  setClient(fileText: string): void {
    const client = parseClientFile(fileText);
    this.deps.secrets.set(CLIENT_SECRET_NAME, JSON.stringify(client));
  }

  /** @returns Whether a client has been chosen. */
  hasClient(): boolean {
    return this.getClient() !== null;
  }

  /** @returns Whether a refresh token is kept, i.e. the user signed in and hasn't signed out. */
  isSignedIn(): boolean {
    return this.deps.secrets.get(REFRESH_TOKEN_SECRET_NAME) !== null;
  }

  /**
   * Runs the browser sign-in and keeps the refresh token it produces.
   * @returns When the user has allowed access.
   */
  async signIn(): Promise<void> {
    const client = this.requireClient();
    const verifier = base64Url(randomBytes(32));
    const state = base64Url(randomBytes(16));
    const { server, redirectUri, code } = await listenForCode(state);
    try {
      const url = new URL(AUTH_URL);
      url.searchParams.set("client_id", client.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", CALENDAR_SCOPE);
      // "offline" plus "consent" makes Google hand out a refresh token even on a repeat sign-in.
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", base64Url(createHash("sha256").update(verifier).digest()));
      url.searchParams.set("code_challenge_method", "S256");
      await this.deps.openExternal(url.toString());
      const tokens = await this.requestTokens({
        grant_type: "authorization_code",
        code: await withTimeout(code, SIGN_IN_TIMEOUT_MS, "Google sign-in timed out. Try again."),
        code_verifier: verifier,
        redirect_uri: redirectUri,
      });
      if (!tokens.refresh_token) {
        throw new Error("Google didn't return a refresh token, so the sign-in can't last. Try again.");
      }
      this.deps.secrets.set(REFRESH_TOKEN_SECRET_NAME, tokens.refresh_token);
      this.keepAccessToken(tokens);
    } finally {
      server.close();
    }
  }

  /**
   * Hands out a current access token, renewing it with the refresh token when it's about to expire.
   * @returns The token for an Authorization header.
   */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt - EXPIRY_MARGIN_MS > this.deps.now()) {
      return this.accessToken.value;
    }
    const refreshToken = this.deps.secrets.get(REFRESH_TOKEN_SECRET_NAME);
    if (!refreshToken) {
      throw new Error("Not signed in to Google.");
    }
    const tokens = await this.requestTokens({ grant_type: "refresh_token", refresh_token: refreshToken });
    return this.keepAccessToken(tokens);
  }

  /** Forgets the sign-in here and asks Google to cancel the token too (best effort). */
  async signOut(): Promise<void> {
    const refreshToken = this.deps.secrets.get(REFRESH_TOKEN_SECRET_NAME);
    this.deps.secrets.set(REFRESH_TOKEN_SECRET_NAME, null);
    this.accessToken = null;
    if (refreshToken) {
      await this.deps
        .fetch(REVOKE_URL, { method: "POST", body: new URLSearchParams({ token: refreshToken }) })
        .catch(() => undefined);
    }
  }

  /**
   * Swaps a code or a refresh token for tokens at Google's token endpoint.
   * @param fields The grant's form fields, without the client's.
   * @returns Google's answer.
   */
  private async requestTokens(fields: Record<string, string>): Promise<TokenResponse> {
    const client = this.requireClient();
    const response = await this.deps.fetch(TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({ ...fields, client_id: client.clientId, client_secret: client.clientSecret }),
    });
    const body = (await response.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string };
    if (!response.ok || !body.access_token) {
      if (body.error === "invalid_grant") {
        // Google withdrew the sign-in (password change, revoked access, or a test app's 7-day limit).
        this.deps.secrets.set(REFRESH_TOKEN_SECRET_NAME, null);
        throw new Error("Google ended the sign-in. Sign in again in Settings.");
      }
      throw new Error(`Google sign-in failed: ${body.error_description ?? body.error ?? `HTTP ${response.status}`}`);
    }
    return body;
  }

  /**
   * Remembers an access token until shortly before it expires.
   * @param tokens Google's answer.
   * @returns The access token.
   */
  private keepAccessToken(tokens: TokenResponse): string {
    this.accessToken = { value: tokens.access_token, expiresAt: this.deps.now() + (tokens.expires_in ?? 3600) * 1000 };
    return tokens.access_token;
  }

  /** @returns The client from a chosen file, else the one built into the app, else null. */
  private getClient(): GoogleClient | null {
    const stored = this.deps.secrets.get(CLIENT_SECRET_NAME);
    return stored ? (JSON.parse(stored) as GoogleClient) : this.deps.builtInClient;
  }

  /** @returns The chosen client; throws when none has been chosen. */
  private requireClient(): GoogleClient {
    const client = this.getClient();
    if (!client) {
      throw new Error("Choose a Google client file (credentials.json) first.");
    }
    return client;
  }
}

/**
 * Reads the Time Center Google client that `npm run google:client` put in `.env` before the build.
 * @returns The client, or null when the build had none.
 */
export function builtInGoogleClient(): GoogleClient | null {
  const clientId = import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID;
  const clientSecret = import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** The fields of Google's token answer this app uses. */
interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
}

/**
 * Reads the client out of a credentials.json file. Google writes a desktop client under "installed" and a
 * web client under "web"; either works for a loopback sign-in.
 * @param fileText The file's contents.
 * @returns The client.
 */
export function parseClientFile(fileText: string): GoogleClient {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    throw new Error("That file isn't JSON. Pick the credentials.json downloaded from Google Cloud.");
  }
  const holder = parsed as { installed?: Record<string, unknown>; web?: Record<string, unknown> } | null;
  const section = holder?.installed ?? holder?.web;
  if (!section || typeof section.client_id !== "string" || typeof section.client_secret !== "string") {
    throw new Error("That file has no OAuth client in it. Pick the credentials.json downloaded from Google Cloud.");
  }
  return { clientId: section.client_id, clientSecret: section.client_secret };
}

/**
 * Starts a one-shot web server on 127.0.0.1 (a port the system picks) that waits for Google to send the
 * browser back with the code.
 * @param state The random value the answer must carry, so another page can't feed in a code.
 * @returns The server, its address, and the code once it arrives.
 */
async function listenForCode(state: string): Promise<{ server: Server; redirectUri: string; code: Promise<string> }> {
  let settle: { resolve(code: string): void; reject(error: Error): void } = { resolve: () => {}, reject: () => {} };
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The browser can answer before signIn starts waiting on the code; that early failure is still read there.
  code.catch(() => undefined);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/") {
      response.writeHead(404).end();
      return;
    }
    // Only Google's answer carries our state; anything else (a page probing local ports) is turned away
    // without ending the sign-in.
    if (url.searchParams.get("state") !== state) {
      response.writeHead(400).end();
      return;
    }
    const error = url.searchParams.get("error");
    const received = url.searchParams.get("code");
    const ok = !error && received;
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(
      ok
        ? "<h2>Time Center is signed in to Google Calendar.</h2><p>You can close this tab.</p>"
        : "<h2>Time Center wasn't signed in.</h2><p>Close this tab and try again from Settings.</p>",
    );
    if (ok) {
      settle.resolve(received);
    } else {
      settle.reject(new Error(error === "access_denied" ? "Google sign-in was cancelled." : "Google sign-in failed."));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, redirectUri: `http://127.0.0.1:${port}`, code };
}

/**
 * Waits for a promise, failing with a message if it takes too long.
 * @param promise What to wait for.
 * @param ms The limit.
 * @param message The error's message.
 * @returns The promise's value.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Encodes bytes as URL-safe base64 without padding, as PKCE and the state value need.
 * @param bytes The bytes.
 * @returns The text.
 */
function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}
