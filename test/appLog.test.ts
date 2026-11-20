import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppLog, MAX_LOG_BYTES, assertPageProblem } from "../src/main/appLog";

describe("AppLog", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "app-log-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("should add one dated line per problem, in a folder it makes, with the text on one line", () => {
    const path = join(dir, "logs", "app.log");
    const log = new AppLog(path, () => Date.parse("2026-11-20T15:00:00Z"));

    log.write("window", "page process gone:\n  crashed (5)");
    log.write("todos", "shows 0 rows but holds 25");

    expect(readFileSync(path, "utf8")).toBe(
      "2026-11-20T15:00:00.000Z [window] page process gone: crashed (5)\n2026-11-20T15:00:00.000Z [todos] shows 0 rows but holds 25\n",
    );
  });

  it("should move a full log aside and start a new one", () => {
    const path = join(dir, "app.log");
    writeFileSync(path, "x".repeat(MAX_LOG_BYTES));

    new AppLog(path).write("app", "after");

    expect(readFileSync(`${path}.1`, "utf8")).toHaveLength(MAX_LOG_BYTES);
    expect(readFileSync(path, "utf8")).toMatch(/\[app\] after\n$/);
  });

  it("should never throw when it can't write", () => {
    const blocked = join(dir, "file");
    writeFileSync(blocked, "");

    expect(() => new AppLog(join(blocked, "app.log")).write("app", "x")).not.toThrow();
    expect(existsSync(join(blocked, "app.log"))).toBe(false);
  });
});

describe("assertPageProblem", () => {
  it("should accept a short source and a message, marking it as from the page", () => {
    expect(assertPageProblem("todos", "shows 0 rows")).toEqual({ source: "page:todos", message: "shows 0 rows" });
  });

  it("should refuse a made-up source or an empty message", () => {
    expect(() => assertPageProblem("../etc", "x")).toThrow(/which part/);
    expect(() => assertPageProblem("todos", " ")).toThrow(/what went wrong/);
  });
});
