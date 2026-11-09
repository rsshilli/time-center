import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

/** The `.env` lines this script owns; electron-vite builds them into the main process. */
const KEYS = { id: "MAIN_VITE_GOOGLE_CLIENT_ID", secret: "MAIN_VITE_GOOGLE_CLIENT_SECRET" } as const;

/**
 * Where QbDVision keeps the shared Time Center client: Secrets Manager in the company AWS account (alias
 * "cherrycircle"), stored in credentials.json's shape. Its Google project's audience is Internal, so only
 * qbdvision.com accounts can sign in with it (checked 2026-11-09 in Google Auth Platform → Audience).
 */
const SHARED_SECRET = { name: "time-center/google-oauth-client", region: "us-east-1" } as const;

/** The `.env` file, next to package.json. */
const ENV_PATH = join(import.meta.dirname, "..", ".env");

/** A Google OAuth client. */
interface Client {
  clientId: string;
  clientSecret: string;
}

await main();

/**
 * Builds the Time Center Google client into the app by writing its id and secret into the gitignored `.env`
 * (keeping every other line). Prints only the client id, never the secret.
 *
 * Usage:
 *   npm run google:client -- ~/Downloads/client_secret_….json   your own client, from Google Cloud
 *   npm run google:client -- --qbdvision                        QbDVision's shared client, from AWS
 *   npm run google:client -- --publish                          upload the client in .env as the shared one
 * The AWS ones use your usual AWS credentials; pick a profile with AWS_PROFILE=… in front.
 */
async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error(
      "Usage: npm run google:client -- <credentials.json>   (or --qbdvision to use QbDVision's shared client)",
    );
    process.exitCode = 1;
    return;
  }
  if (arg === "--publish") {
    await publishSharedClient(readEnvClient());
    return;
  }
  const client = arg === "--qbdvision" ? await fetchSharedClient() : readClient(readFileSync(arg, "utf8"));
  writeEnvClient(client);
  console.log(`Saved Google client ${client.clientId} to .env. Rebuild (npm run packageAndRun) to build it in.`);
}

/**
 * Stores a client as QbDVision's shared one, creating the secret the first time.
 * @param client The client.
 */
async function publishSharedClient(client: Client): Promise<void> {
  const secrets = new SecretsManagerClient({ region: SHARED_SECRET.region });
  const value = JSON.stringify({ installed: { client_id: client.clientId, client_secret: client.clientSecret } });
  try {
    await secrets.send(new PutSecretValueCommand({ SecretId: SHARED_SECRET.name, SecretString: value }));
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) {
      throw error;
    }
    await secrets.send(
      new CreateSecretCommand({
        Name: SHARED_SECRET.name,
        Description: "Time Center's Google OAuth client (desktop, calendar.readonly, qbdvision.com only). See the time-center README.",
        SecretString: value,
      }),
    );
  }
  console.log(`Published Google client ${client.clientId} as ${SHARED_SECRET.name} (${SHARED_SECRET.region}).`);
}

/**
 * Reads the client the `.env` holds.
 * @returns The client.
 */
function readEnvClient(): Client {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split("\n") : [];
  const value = (key: string) => lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1).trim();
  const clientId = value(KEYS.id);
  const clientSecret = value(KEYS.secret);
  if (!clientId || !clientSecret) {
    throw new Error(".env has no Google client to publish. Run npm run google:client -- <credentials.json> first.");
  }
  return { clientId, clientSecret };
}

/**
 * Downloads QbDVision's shared client from Secrets Manager.
 * @returns The client.
 */
async function fetchSharedClient(): Promise<Client> {
  const secrets = new SecretsManagerClient({ region: SHARED_SECRET.region });
  try {
    const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: SHARED_SECRET.name }));
    return readClient(SecretString ?? "");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Couldn't read ${SHARED_SECRET.name} from QbDVision's AWS account (${reason}). ` +
        "Check you're signed in to that account (aws sts get-caller-identity), or set AWS_PROFILE.",
    );
  }
}

/**
 * Reads the client out of a credentials.json, desktop ("installed") or web.
 * @param text The file's contents.
 * @returns The id and secret.
 */
function readClient(text: string): Client {
  const parsed = JSON.parse(text) as { installed?: Record<string, unknown>; web?: Record<string, unknown> };
  const section = parsed.installed ?? parsed.web;
  if (!section || typeof section.client_id !== "string" || typeof section.client_secret !== "string") {
    throw new Error("That file has no OAuth client in it. Download the Desktop client's JSON from Google Cloud.");
  }
  return { clientId: section.client_id, clientSecret: section.client_secret };
}

/**
 * Writes the client into `.env`, keeping every other line, readable only by you.
 * @param client The client.
 */
function writeEnvClient(client: Client): void {
  const kept = existsSync(ENV_PATH)
    ? readFileSync(ENV_PATH, "utf8")
        .split("\n")
        .filter((line) => line.trim() && !line.startsWith(`${KEYS.id}=`) && !line.startsWith(`${KEYS.secret}=`))
    : [];
  writeFileSync(ENV_PATH, [...kept, `${KEYS.id}=${client.clientId}`, `${KEYS.secret}=${client.clientSecret}`, ""].join("\n"), {
    mode: 0o600,
  });
  // `mode` only applies to a new file; an existing .env may have been readable by others.
  chmodSync(ENV_PATH, 0o600);
}
