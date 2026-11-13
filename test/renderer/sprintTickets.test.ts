import { typeClass } from "../../src/renderer/SprintTickets";

describe("typeClass", () => {
  it("should colour bugs, stories and tasks the way Jira does, whatever their case", () => {
    expect(typeClass("Bug")).toBe("bug");
    expect(typeClass("story")).toBe("story");
    expect(typeClass("Task")).toBe("task");
    expect(typeClass("Sub-task")).toBe("task");
  });

  it("should leave any other type plain", () => {
    expect(typeClass("Epic")).toBe("");
    expect(typeClass("")).toBe("");
  });
});
