import { FIELD_LABELS } from "../../src/renderer/RulesEditor";
import { ruleMatches } from "../../src/renderer/ruleFilter";
import type { CategoryRule } from "../../src/shared/ipc";

const github: CategoryRule = { field: "domain", pattern: "github.com", category: "Coding" };

describe("ruleMatches", () => {
  it("should match a rule's pattern, category or field label, ignoring case and spaces around the query", () => {
    expect(ruleMatches(github, " GitHub ", FIELD_LABELS)).toBe(true);
    expect(ruleMatches(github, "cod", FIELD_LABELS)).toBe(true);
    expect(ruleMatches(github, "website", FIELD_LABELS)).toBe(true);
    expect(ruleMatches(github, "slack", FIELD_LABELS)).toBe(false);
  });

  it("should show every rule for a blank query, and a blank rule for any query", () => {
    expect(ruleMatches(github, "  ", FIELD_LABELS)).toBe(true);
    expect(ruleMatches({ field: "app", pattern: "", category: "" }, "slack", FIELD_LABELS)).toBe(true);
  });
});
