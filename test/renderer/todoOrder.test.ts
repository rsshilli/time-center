import { escapeMarkdown, hasWords, moveItem } from "../../src/renderer/todoOrder";

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
