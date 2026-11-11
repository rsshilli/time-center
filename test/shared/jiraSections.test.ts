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

  it("should leave tasks and epics as they are", () => {
    expect(withRequiredSections("Do it.", "Task")).toBe("Do it.");
    expect(requiredSections("Epic (URS)")).toEqual([]);
  });
});
