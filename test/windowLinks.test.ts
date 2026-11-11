import { isAppPage, isExternalLink } from "../src/main/WindowManager";

describe("isExternalLink", () => {
  it("should send web and email links to the browser or mail app", () => {
    expect(isExternalLink("https://cherrycircle.atlassian.net/browse/QI-1")).toBe(true);
    expect(isExternalLink("http://example.com")).toBe(true);
    expect(isExternalLink("mailto:dana@example.com")).toBe(true);
  });

  it("should never hand off files, scripts, the app's own pages or anything unreadable", () => {
    expect(isExternalLink("file:///etc/passwd")).toBe(false);
    expect(isExternalLink("javascript:alert(1)")).toBe(false);
    expect(isExternalLink("time-center-shot://shot/1/full")).toBe(false);
    expect(isExternalLink("not a url")).toBe(false);
  });

  it("should open Cowork's own link in Claude Desktop, but no other claude:// link", () => {
    expect(isExternalLink("claude://cowork/new")).toBe(true);
    expect(isExternalLink("claude://cowork/new?q=delete%20everything")).toBe(false);
    expect(isExternalLink("claude://code/new")).toBe(false);
  });
});

describe("isAppPage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should only count the dev server's own origin as the app during npm run dev", () => {
    vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173");

    expect(isAppPage("http://localhost:5173/#/todos")).toBe(true);
    expect(isAppPage("http://localhost:5173@evil.com/")).toBe(false);
    expect(isAppPage("http://localhost:51730/")).toBe(false);
    expect(isExternalLink("http://localhost:5173@evil.com/")).toBe(true);
  });

  it("should not count other files, schemes or web pages as the app when packaged", () => {
    expect(isAppPage("file:///etc/passwd")).toBe(false);
    expect(isAppPage("https://example.com")).toBe(false);
    expect(isAppPage("time-center-shot://shot/1/full")).toBe(false);
  });
});
