import { escapeMarkdown, hasWords, moveItem, moveTodo, stepProgress } from "../../src/renderer/todoOrder";

describe("moveTodo", () => {
  const layout = { work: [1, 2, 3], personal: [7, 8] };

  it("should reorder within a section the way moveItem does", () => {
    expect(moveTodo(layout, 1, "work", 3)).toEqual({ work: [2, 3, 1], personal: [7, 8] });
  });

  it("should put an item dropped on the other section's item just above it", () => {
    expect(moveTodo(layout, 2, "personal", 8)).toEqual({ work: [1, 3], personal: [7, 2, 8] });
    expect(moveTodo(layout, 7, "work", 1)).toEqual({ work: [7, 1, 2, 3], personal: [8] });
  });

  it("should put an item dropped on a section's empty space at its end, including an empty section", () => {
    expect(moveTodo(layout, 3, "personal", null)).toEqual({ work: [1, 2], personal: [7, 8, 3] });
    expect(moveTodo({ work: [1], personal: [] }, 1, "personal", null)).toEqual({ work: [], personal: [1] });
    expect(moveTodo(layout, 1, "work", null)).toEqual({ work: [2, 3, 1], personal: [7, 8] });
  });

  it("should give back the same layout when nothing moves", () => {
    expect(moveTodo(layout, 3, "work", null)).toBe(layout);
    expect(moveTodo(layout, 2, "work", 2)).toBe(layout);
    expect(moveTodo(layout, 9, "work", 1)).toBe(layout);
    expect(moveTodo(layout, 1, "personal", 2)).toBe(layout);
  });
});

describe("moveItem", () => {
  it("should put the dragged item in the target's place, moving down or up", () => {
    expect(moveItem([1, 2, 3, 4], 1, 3)).toEqual([2, 3, 1, 4]);
    expect(moveItem([1, 2, 3, 4], 4, 2)).toEqual([1, 4, 2, 3]);
  });

  it("should give back the same list when dropped on itself or on something not in it", () => {
    const ids = [1, 2, 3];
    expect(moveItem(ids, 2, 2)).toBe(ids);
    expect(moveItem(ids, 2, 9)).toBe(ids);
    expect(moveItem(ids, 9, 2)).toBe(ids);
  });
});

describe("hasWords", () => {
  it("should say whether an item has more than whitespace and Markdown markers", () => {
    expect(hasWords("Send the keys")).toBe(true);
    expect(hasWords("- [x](y)")).toBe(true);
    expect(hasWords("")).toBe(false);
    expect(hasWords("  \n- \n**  **\n&nbsp;")).toBe(false);
  });
});

describe("escapeMarkdown", () => {
  it("should keep an action item's stars, underscores and brackets as plain text", () => {
    expect(escapeMarkdown("You: update *config* in my_file [now]")).toBe("You: update \\*config\\* in my\\_file \\[now\\]");
    expect(escapeMarkdown("Them: send the deck")).toBe("Them: send the deck");
  });
});

describe("stepProgress", () => {
  it("should count the ticked sub-steps at any depth, and say none for an item without them", () => {
    expect(stepProgress("Ship it\n\n- [x] build\n- [ ] test\n  - [X] unit\n  - [ ] e2e\n- plain bullet")).toEqual({ done: 2, total: 4 });
    expect(stepProgress("Ship it\n\n- plain bullet")).toBeNull();
  });
});
