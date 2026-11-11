import { requiredSections, withRequiredSections } from "../../src/shared/jiraSections";

describe("withRequiredSections", () => {
  it("should add acceptance criteria to a story that has none, and leave one that has them alone", () => {
    expect(withRequiredSections("Let admins export.", "Story (FRS)")).toBe("Let admins export.\n\n## Acceptance Criteria\n- To be written.");
    const written = "Let admins export.\n\n### acceptance criteria:\n- A CSV downloads";
    expect(withRequiredSections(written, "Story (FRS)")).toBe(written);
  });

  it("should add the steps to reproduce and expected / actual a bug is missing, keeping the ones it has", () => {
    const withSteps = "Export fails.\n\n## Steps to reproduce\n1. Click Export";
    expect(withRequiredSections(withSteps, "Bug")).toBe(`${withSteps}\n\n## Expected / Actual\nExpected: To be written.\n\nActual: To be written.`);
    const complete = `${withSteps}\n\n## Expected/Actual\nExpected: a file\nActual: an error`;
    expect(withRequiredSections(complete, "Bug")).toBe(complete);
  });

  it("should not count a sentence that merely mentions a section as the section", () => {
    expect(withRequiredSections("The acceptance criteria are below.", "Story")).toContain("## Acceptance Criteria");
  });

  it("should recognise bold headings, headings that go on, and Expected and Actual written apart", () => {
    expect(withRequiredSections("**Acceptance Criteria**\n- works", "Story")).toBe("**Acceptance Criteria**\n- works");
    expect(withRequiredSections("## Acceptance criteria (draft)\n- works", "Story")).not.toContain("To be written");
    const apart = "## Steps to reproduce\n1. Go\n\n## Expected\nA file\n\n## Actual\nAn error";
    expect(withRequiredSections(apart, "Bug")).toBe(apart);
    expect(withRequiredSections("## Steps to reproduce\n1. Go\n\n## Expected vs. Actual\nx", "Bug")).not.toContain("To be written");
  });

  it("should not count a heading inside a code block", () => {
    expect(withRequiredSections("```\n## Acceptance Criteria\n```", "Story")).toContain("```\n\n## Acceptance Criteria\n- To be written.");
  });

  it("should swap one type's unfilled sections for another's, keeping sections someone wrote in", () => {
    const story = withRequiredSections("Export fails.", "Story");
    expect(withRequiredSections(story, "Bug")).toBe(withRequiredSections("Export fails.", "Bug"));
    const written = "Export fails.\n\n## Acceptance Criteria\n- A CSV downloads";
    expect(withRequiredSections(written, "Bug")).toContain("- A CSV downloads");
    expect(withRequiredSections(withRequiredSections("x", "Bug"), "Task")).toBe("x");
  });

  it("should leave tasks and epics as they are", () => {
    expect(withRequiredSections("Do it.", "Task")).toBe("Do it.");
    expect(requiredSections("Epic (URS)")).toEqual([]);
  });
});
