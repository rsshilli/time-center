import { colourFor, formatDuration } from "../../src/renderer/format";

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
});
