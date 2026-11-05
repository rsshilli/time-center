import { createHmac, randomBytes } from "node:crypto";
import { MARKER_LIFETIME_MS, MARKER_PREFIX, markerMessage } from "../../../extension/src/joinMarker";

/** The setting that holds the key shared with the Chrome extension, made once and then kept. */
export const EXTENSION_KEY_SETTING = "extensionKey";

/**
 * Reads the key shared with the extension, making it on first use. It stays the same across launches,
 * because Chrome keeps running the copy of the extension it loaded until it's reloaded.
 * @param settings The settings table.
 * @returns The key, as 64 hex characters.
 */
export function extensionKey(settings: { getSetting(key: string): string | null; setSetting(key: string, value: string | null): void }): string {
  const existing = settings.getSetting(EXTENSION_KEY_SETTING);
  if (existing && /^[0-9a-f]{64}$/.test(existing)) {
    return existing;
  }
  const made = randomBytes(32).toString("hex");
  settings.setSetting(EXTENSION_KEY_SETTING, made);
  return made;
}

/**
 * Makes the signed marker for a meeting address the app is about to open.
 * @param keyHex The shared key.
 * @param url The address.
 * @param now The current time.
 * @returns The hash to put on it, e.g. "tc-join.1762354800000.ab12…".
 */
export function signMarker(keyHex: string, url: URL, now: number): string {
  const expiresAt = now + MARKER_LIFETIME_MS;
  const signature = createHmac("sha256", Buffer.from(keyHex, "hex"))
    .update(markerMessage(url.hostname, url.pathname, expiresAt))
    .digest("hex");
  return `${MARKER_PREFIX}${expiresAt}.${signature}`;
}
