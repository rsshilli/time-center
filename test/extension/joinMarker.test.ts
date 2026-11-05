import { MARKER_LIFETIME_MS, verifyMarker } from "../../extension/src/joinMarker";
import { extensionKey, signMarker } from "../../src/main/calendar/markerSigner";

const KEY = "0f".repeat(32);
const NOW = Date.parse("2026-11-05T15:00:00Z");

describe("verifyMarker", () => {
  const meet = new URL("https://meet.google.com/abc-defg-hij?authuser=r%40x.com");

  it("should accept the marker the app signed for this meeting", async () => {
    const hash = `#${signMarker(KEY, meet, NOW)}`;
    expect(await verifyMarker(hash, "meet.google.com", "/abc-defg-hij", KEY, NOW + 5_000)).toBe(true);
  });

  it("should refuse the old plain marker a web page could type", async () => {
    expect(await verifyMarker("#tc-join", "meet.google.com", "/abc-defg-hij", KEY, NOW)).toBe(false);
  });

  it("should refuse a marker copied onto another meeting", async () => {
    const hash = `#${signMarker(KEY, meet, NOW)}`;
    expect(await verifyMarker(hash, "meet.google.com", "/zzz-zzzz-zzz", KEY, NOW)).toBe(false);
  });

  it("should refuse a marker signed with another key", async () => {
    const hash = `#${signMarker("aa".repeat(32), meet, NOW)}`;
    expect(await verifyMarker(hash, "meet.google.com", "/abc-defg-hij", KEY, NOW)).toBe(false);
  });

  it("should refuse an expired marker, and one claiming to last too long", async () => {
    const hash = `#${signMarker(KEY, meet, NOW)}`;
    expect(await verifyMarker(hash, "meet.google.com", "/abc-defg-hij", KEY, NOW + MARKER_LIFETIME_MS + 1)).toBe(false);
    expect(await verifyMarker(hash, "meet.google.com", "/abc-defg-hij", KEY, NOW - 60 * 60_000)).toBe(false);
  });

  it("should refuse everything when the extension has no key", async () => {
    const hash = `#${signMarker(KEY, meet, NOW)}`;
    expect(await verifyMarker(hash, "meet.google.com", "/abc-defg-hij", "", NOW)).toBe(false);
  });
});

describe("extensionKey", () => {
  it("should make a key once and keep it", () => {
    const saved = new Map<string, string | null>();
    const settings = { getSetting: (key: string) => saved.get(key) ?? null, setSetting: (key: string, value: string | null) => saved.set(key, value) };
    const first = extensionKey(settings);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(extensionKey(settings)).toBe(first);
  });
});
