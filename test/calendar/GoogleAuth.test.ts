import { GoogleAuth, parseClientFile } from "../../src/main/calendar/GoogleAuth";

const CLIENT_FILE = JSON.stringify({
  installed: { client_id: "client-123", client_secret: "shh", redirect_uris: ["http://localhost"] },
});

describe("GoogleAuth", () => {
  let secrets: Map<string, string>;
  let clock: number;
  let tokenCalls: URLSearchParams[];
  let tokenAnswer: { status: number; body: Record<string, unknown> };
  let builtInClient: { clientId: string; clientSecret: string } | null;

  beforeEach(() => {
    builtInClient = null;
    secrets = new Map();
    clock = 1_000_000;
    tokenCalls = [];
    tokenAnswer = { status: 200, body: { access_token: "access-1", expires_in: 3600, refresh_token: "refresh-1" } };
  });

  /**
   * Builds the sign-in with a fake Google token endpoint and a browser that follows a script.
   * @param browser What the "browser" does with the sign-in page's address.
   * @returns The sign-in.
   */
  const build = (browser: (url: URL) => Promise<void> = async () => {}) =>
    new GoogleAuth({
      secrets: {
        get: (name) => secrets.get(name) ?? null,
        set: (name, value) => {
          if (value === null) {
            secrets.delete(name);
          } else {
            secrets.set(name, value);
          }
        },
      },
      builtInClient,
      openExternal: (url) => browser(new URL(url)),
      fetch: (async (input: string | URL, init?: RequestInit) => {
        if (String(input).endsWith("/token")) {
          tokenCalls.push(init?.body as URLSearchParams);
          return new Response(JSON.stringify(tokenAnswer.body), { status: tokenAnswer.status });
        }
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      now: () => clock,
    });

  /**
   * A browser in which the user allows access: Google sends it back to the app's address with a code.
   * @param url The sign-in page's address.
   */
  const userAllows = async (url: URL) => {
    const back = new URL(url.searchParams.get("redirect_uri") as string);
    back.searchParams.set("code", "code-xyz");
    back.searchParams.set("state", url.searchParams.get("state") as string);
    await fetch(back);
  };

  it("should sign in through the loopback page and keep only the refresh token", async () => {
    const auth = build(userAllows);
    auth.setClient(CLIENT_FILE);
    await auth.signIn();

    expect(auth.isSignedIn()).toBe(true);
    expect(secrets.get("google.refreshToken")).toBe("refresh-1");
    const exchange = tokenCalls[0];
    expect(exchange.get("code")).toBe("code-xyz");
    expect(exchange.get("code_verifier")).toMatch(/^[\w-]{43}$/);
    expect(exchange.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await auth.getAccessToken()).toBe("access-1");
    expect(tokenCalls).toHaveLength(1);
  });

  it("should ask only for read-only calendar access, with PKCE", async () => {
    let page: URL | null = null;
    const auth = build(async (url) => {
      page = url;
      await userAllows(url);
    });
    auth.setClient(CLIENT_FILE);
    await auth.signIn();
    const params = (page as unknown as URL).searchParams;
    expect(params.get("scope")).toBe("https://www.googleapis.com/auth/calendar.readonly");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("access_type")).toBe("offline");
  });

  it("should turn away an answer without its state and keep waiting for Google's", async () => {
    const auth = build(async (url) => {
      const back = new URL(url.searchParams.get("redirect_uri") as string);
      const forged = new URL(back);
      forged.searchParams.set("code", "stolen");
      forged.searchParams.set("state", "wrong");
      expect((await fetch(forged)).status).toBe(400);
      await userAllows(url);
    });
    auth.setClient(CLIENT_FILE);
    await auth.signIn();
    expect(tokenCalls.map((call) => call.get("code"))).toEqual(["code-xyz"]);
  });

  it("should say so when the user cancels on Google's page", async () => {
    const auth = build(async (url) => {
      const back = new URL(url.searchParams.get("redirect_uri") as string);
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("state", url.searchParams.get("state") as string);
      await fetch(back);
    });
    auth.setClient(CLIENT_FILE);
    await expect(auth.signIn()).rejects.toThrow(/cancelled/);
  });

  it("should renew the access token with the refresh token once it's about to expire", async () => {
    const auth = build(userAllows);
    auth.setClient(CLIENT_FILE);
    await auth.signIn();
    clock += 3600_000;
    tokenAnswer.body = { access_token: "access-2", expires_in: 3600 };
    expect(await auth.getAccessToken()).toBe("access-2");
    expect(tokenCalls[1].get("grant_type")).toBe("refresh_token");
    expect(tokenCalls[1].get("refresh_token")).toBe("refresh-1");
  });

  it("should sign out when Google has withdrawn the refresh token", async () => {
    secrets.set("google.refreshToken", "old");
    const auth = build();
    auth.setClient(CLIENT_FILE);
    tokenAnswer = { status: 400, body: { error: "invalid_grant" } };
    await expect(auth.getAccessToken()).rejects.toThrow(/Sign in again/);
    expect(auth.isSignedIn()).toBe(false);
  });

  it("should forget the sign-in on sign-out", async () => {
    secrets.set("google.refreshToken", "old");
    const auth = build();
    await auth.signOut();
    expect(auth.isSignedIn()).toBe(false);
  });

  it("should refuse to sign in when the build has no client and none was chosen", async () => {
    await expect(build().signIn()).rejects.toThrow(/credentials\.json/);
  });

  it("should sign in with the client built into the app, with no file chosen", async () => {
    builtInClient = { clientId: "built-in", clientSecret: "b" };
    const auth = build(userAllows);
    expect(auth.hasClient()).toBe(true);
    await auth.signIn();
    expect(tokenCalls[0].get("client_id")).toBe("built-in");
  });

  it("should prefer a chosen client file over the built-in client", async () => {
    builtInClient = { clientId: "built-in", clientSecret: "b" };
    const auth = build(userAllows);
    auth.setClient(CLIENT_FILE);
    await auth.signIn();
    expect(tokenCalls[0].get("client_id")).toBe("client-123");
  });
});

describe("parseClientFile", () => {
  it("should read a desktop client and a web client", () => {
    expect(parseClientFile(CLIENT_FILE)).toEqual({ clientId: "client-123", clientSecret: "shh" });
    expect(parseClientFile(JSON.stringify({ web: { client_id: "w", client_secret: "s" } }))).toEqual({
      clientId: "w",
      clientSecret: "s",
    });
  });

  it("should explain what's wrong with a file that isn't a client", () => {
    expect(() => parseClientFile("not json")).toThrow(/isn't JSON/);
    expect(() => parseClientFile(JSON.stringify({ type: "service_account" }))).toThrow(/no OAuth client/);
  });
});
