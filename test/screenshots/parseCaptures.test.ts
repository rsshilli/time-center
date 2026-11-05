import { parseCaptures } from "../../src/main/screenshots/platform";

describe("parseCaptures", () => {
  it("should decode each display's pictures from the helper's base64", () => {
    const output = JSON.stringify([
      { displayId: "2", full: Buffer.from("full-2").toString("base64"), thumb: Buffer.from("t2").toString("base64") },
    ]);
    const [shot] = parseCaptures(`${output}\n`);
    expect(shot.displayId).toBe("2");
    expect(shot.full.toString()).toBe("full-2");
    expect(shot.thumb.toString()).toBe("t2");
  });

  it("should throw on an answer missing a picture, so nothing half-made is saved", () => {
    expect(() => parseCaptures('[{"displayId":"1","full":"AA=="}]')).toThrow(/missing/);
    expect(() => parseCaptures('{"displayId":"1"}')).toThrow(/list/);
    expect(() => parseCaptures("")).toThrow();
  });
});
