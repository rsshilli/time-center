import { screenshotUrl } from "../../src/shared/ipc";

vi.mock("electron", () => ({ net: {}, protocol: {} }));

const { parseScreenshotUrl } = await import("../../src/main/screenshots/screenshotProtocol");

describe("parseScreenshotUrl", () => {
  it("should read back the id and size from a URL built by screenshotUrl", () => {
    expect(parseScreenshotUrl(screenshotUrl(42, "thumb"))).toEqual({ id: 42, size: "thumb" });
    expect(parseScreenshotUrl(screenshotUrl(7, "full"))).toEqual({ id: 7, size: "full" });
  });

  it("should reject any other path, so the renderer can't ask for other files", () => {
    expect(parseScreenshotUrl("time-center-shot://shot/6/../../etc/passwd")).toBeNull();
    expect(parseScreenshotUrl("time-center-shot://0.0.0.6/thumb")).toBeNull();
  });
});
