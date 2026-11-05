/**
 * The marker Time Center puts on a meeting address it opens to join: `#tc-join.<expiry>.<signature>`.
 * The signature is an HMAC-SHA256, under a key only the app and the extension hold, of the page's host,
 * path and the expiry. So a web page can't send your browser to its own meeting and have the extension
 * click Join: it can't produce a valid signature, and a copied one only fits that one meeting, briefly.
 * Shared by the app (which signs) and the extension (which checks), so the two can't drift apart.
 */

/** What every marker starts with. */
export const MARKER_PREFIX = "tc-join.";

/** How long a signed address stays valid after the app opens it. */
export const MARKER_LIFETIME_MS = 2 * 60_000;

/**
 * Builds the text that gets signed.
 * @param hostname The meeting page's host.
 * @param pathname Its path.
 * @param expiresAt When the marker stops being valid, ms since 1970.
 * @returns e.g. "meet.google.com/abc-defg-hij|1762354800000".
 */
export function markerMessage(hostname: string, pathname: string, expiresAt: number): string {
  return `${hostname.toLowerCase()}${pathname}|${expiresAt}`;
}

/**
 * Checks a page's marker: the right shape, not expired, and signed with the key for this host and path.
 * @param hash The page's `location.hash`, e.g. "#tc-join.1762354800000.ab12…".
 * @param hostname The page's host.
 * @param pathname The page's path.
 * @param keyHex The shared key, as hex.
 * @param now The current time.
 * @returns True only for a valid marker.
 */
export async function verifyMarker(
  hash: string,
  hostname: string,
  pathname: string,
  keyHex: string,
  now: number,
): Promise<boolean> {
  const match = hash.match(/^#tc-join\.(\d{1,15})\.([0-9a-f]{64})$/);
  if (!match || !/^[0-9a-f]{64}$/.test(keyHex)) {
    return false;
  }
  const expiresAt = Number(match[1]);
  if (now > expiresAt || expiresAt - now > MARKER_LIFETIME_MS) {
    return false;
  }
  const key = await crypto.subtle.importKey("raw", fromHex(keyHex), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const message = new TextEncoder().encode(markerMessage(hostname, pathname, expiresAt));
  return crypto.subtle.verify("HMAC", key, fromHex(match[2]), message);
}

/**
 * Turns hex text into bytes.
 * @param hex The text.
 * @returns The bytes.
 */
function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
