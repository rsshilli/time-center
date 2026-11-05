import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The `.env` lines this script owns; electron-vite builds them into the main process. */
const KEYS = { id: "MAIN_VITE_GOOGLE_CLIENT_ID", secret: "MAIN_VITE_GOOGLE_CLIENT_SECRET" } as const;

main();

/**
 * Builds the Time Center Google client into the app: reads the credentials.json downloaded from Google
 * Cloud and writes its id and secret into the gitignored `.env`, keeping every other line. Prints only the
 * client id, never the secret.
 *
 * Usage: npm run google:client -- ~/Downloads/client_secret_….json
 */
function main(): void {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npm run google:client -- <path to the downloaded credentials.json>");
    process.exitCode = 1;
    return;
  }
  const client = readClient(readFileSync(file, "utf8"));
  const envPath = join(import.meta.dirname, "..", ".env");
  const kept = existsSync(envPath)
    ? readFileSync(envPath, "utf8")
        .split("\n")
        .filter((line) => line.trim() && !line.startsWith(`${KEYS.id}=`) && !line.startsWith(`${KEYS.secret}=`))
    : [];
  writeFileSync(envPath, [...kept, `${KEYS.id}=${client.clientId}`, `${KEYS.secret}=${client.clientSecret}`, ""].join("\n"), {
    mode: 0o600,
  });
  // `mode` only applies to a new file; an existing .env may have been readable by others.
  chmodSync(envPath, 0o600);
  console.log(`Saved Google client ${client.clientId} to .env. Rebuild (npm run packageAndRun) to build it in.`);
}

/**
 * Reads the client out of a credentials.json, desktop ("installed") or web.
 * @param text The file's contents.
 * @returns The id and secret.
 */
function readClient(text: string): { clientId: string; clientSecret: string } {
  const parsed = JSON.parse(text) as { installed?: Record<string, unknown>; web?: Record<string, unknown> };
  const section = parsed.installed ?? parsed.web;
  if (!section || typeof section.client_id !== "string" || typeof section.client_secret !== "string") {
    throw new Error("That file has no OAuth client in it. Download the Desktop client's JSON from Google Cloud.");
  }
  return { clientId: section.client_id, clientSecret: section.client_secret };
}
