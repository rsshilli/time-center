import {
  STARTER_RULES,
  UNCATEGORIZED,
  assertRules,
  categorize,
  domainOf,
  parseRules,
  projectOf,
  ruleMatches,
} from "../../src/main/activity/classify";

/** A stretch with only the given fields set. */
const item = (fields: Partial<Parameters<typeof categorize>[0]>) => ({
  app: null,
  domain: null,
  url: null,
  title: null,
  project: null,
  ...fields,
});

describe("categorize", () => {
  it("should put WebStorm time in Coding with the starter rules", () => {
    expect(categorize(item({ app: "WebStorm" }), STARTER_RULES)).toBe("Coding");
  });

  it("should put a github.com subdomain in Code review", () => {
    expect(categorize(item({ app: "Google Chrome", domain: "gist.github.com" }), STARTER_RULES)).toBe("Code review");
  });

  it("should put Google Meet in Meetings", () => {
    expect(categorize(item({ app: "Google Chrome", domain: "meet.google.com" }), STARTER_RULES)).toBe("Meetings");
  });

  it("should put the Zoom app in Meetings under its new name and its old one", () => {
    expect(categorize(item({ app: "Zoom" }), STARTER_RULES)).toBe("Meetings");
    expect(categorize(item({ app: "zoom.us" }), STARTER_RULES)).toBe("Meetings");
  });

  it("should fall back to Uncategorized when no rule matches", () => {
    expect(categorize(item({ app: "Finder" }), STARTER_RULES)).toBe(UNCATEGORIZED);
  });

  it("should use the first rule that matches", () => {
    const rules = [
      { field: "url" as const, pattern: "github.com/QbDVision-Inc", category: "QbDVision" },
      { field: "domain" as const, pattern: "github.com", category: "Code review" },
    ];
    expect(categorize(item({ url: "https://github.com/QbDVision-Inc/qbdvision/pull/1", domain: "github.com" }), rules)).toBe(
      "QbDVision",
    );
  });
});

describe("ruleMatches", () => {
  it("should ignore case", () => {
    expect(ruleMatches({ field: "app", pattern: "slack", category: "x" }, item({ app: "Slack" }))).toBe(true);
  });

  it("should not match a domain that only ends with the same letters", () => {
    expect(ruleMatches({ field: "domain", pattern: "github.com", category: "x" }, item({ domain: "notgithub.com" }))).toBe(
      false,
    );
  });

  it("should never match a blank pattern", () => {
    expect(ruleMatches({ field: "app", pattern: "  ", category: "x" }, item({ app: "Slack" }))).toBe(false);
  });
});

describe("domainOf", () => {
  it("should return the host without www", () => {
    expect(domainOf("https://www.github.com/a")).toBe("github.com");
  });

  it("should return null for a non-web address", () => {
    expect(domainOf("chrome://settings")).toBeNull();
  });

  it("should return null for text that isn't an address", () => {
    expect(domainOf("not a url")).toBeNull();
  });
});

describe("projectOf", () => {
  it("should read the project from a WebStorm title", () => {
    expect(projectOf("com.jetbrains.WebStorm", "time-center – PLAN.md")).toBe("time-center");
  });

  it("should use the whole title when there is no file part", () => {
    expect(projectOf("com.jetbrains.WebStorm", "qbdvision")).toBe("qbdvision");
  });

  it("should return null for apps that aren't JetBrains IDEs", () => {
    expect(projectOf("com.google.Chrome", "a – b")).toBeNull();
  });
});

describe("parseRules", () => {
  it("should return the starter rules when nothing was saved", () => {
    expect(parseRules(null)).toEqual(STARTER_RULES);
  });

  it("should return the starter rules when the saved text is damaged", () => {
    expect(parseRules("{nope")).toEqual(STARTER_RULES);
  });

  it("should keep an empty saved list empty", () => {
    expect(parseRules("[]")).toEqual([]);
  });
});

describe("assertRules", () => {
  it("should trim the pattern and category", () => {
    expect(assertRules([{ field: "app", pattern: " Slack ", category: " Chat " }])).toEqual([
      { field: "app", pattern: "Slack", category: "Chat" },
    ]);
  });

  it("should reject an unknown field", () => {
    expect(() => assertRules([{ field: "color", pattern: "x", category: "y" }])).toThrow(/Rule 1/);
  });

  it("should reject a blank category", () => {
    expect(() => assertRules([{ field: "app", pattern: "x", category: "" }])).toThrow(/Rule 1/);
  });
});
