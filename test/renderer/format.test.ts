import { colourFor, formatDuration } from "../../src/renderer/format";
import { type MeetingType, meetingCategory } from "../../src/shared/ipc";

describe("formatDuration", () => {
  it("should say 0m for no time at all", () => {
    expect(formatDuration(0)).toBe("0m");
  });

  it("should say under a minute for a few seconds", () => {
    expect(formatDuration(20_000)).toBe("under a minute");
  });

  it("should show hours with two-digit minutes", () => {
    expect(formatDuration((2 * 60 + 5) * 60_000)).toBe("2h 05m");
  });
});

describe("colourFor", () => {
  it("should give a category the same colour every time", () => {
    expect(colourFor("Coding")).toBe(colourFor("Coding"));
  });

  it("should give Away its fixed grey", () => {
    expect(colourFor("Away")).toBe("#b8b8bd");
  });

  it("should give every meeting type a different shade of green", () => {
    const types: (MeetingType | null)[] = [null, "one-on-one", "dsu", "management", "architecture", "customer", "other"];
    const meetings = types.map((type) => colourFor(meetingCategory(type)));
    expect(new Set(meetings).size).toBe(meetings.length);
    for (const colour of meetings) {
      expect(hue(colour)).toBeGreaterThanOrEqual(75);
      expect(hue(colour)).toBeLessThanOrEqual(170);
    }
  });

  it("should give work categories hues far apart, and none of them green", () => {
    const work = ["Coding", "Communication", "Code review", "Personal", "Research", "Testing", "Time Management", "Lilly", "Security"];
    for (const name of work) {
      const h = hue(colourFor(name));
      expect(h < 75 || h > 170, `${name} is green`).toBe(true);
    }
    const gap = Math.abs(hue(colourFor("Coding")) - hue(colourFor("Communication")));
    expect(Math.min(gap, 360 - gap)).toBeGreaterThan(90);
  });
});

/**
 * A colour's hue, in degrees.
 * @param colour A #rrggbb colour.
 * @returns 0–360.
 */
function hue(colour: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(colour.slice(at, at + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const span = max - Math.min(r, g, b);
  if (span === 0) {
    return 0;
  }
  const raw = max === r ? ((g - b) / span) % 6 : max === g ? (b - r) / span + 2 : (r - g) / span + 4;
  return (raw * 60 + 360) % 360;
}
