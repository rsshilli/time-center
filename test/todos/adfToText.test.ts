import { adfToText } from "../../src/main/todos/adfToText";

/** A text node. */
const text = (value: string) => ({ type: "text", text: value });

/** A paragraph of text nodes. */
const paragraph = (...parts: object[]) => ({ type: "paragraph", content: parts });

/** A list item holding one paragraph and, optionally, a list under it. */
const item = (value: string, nested?: object) => ({ type: "listItem", content: [paragraph(text(value)), ...(nested ? [nested] : [])] });

describe("adfToText", () => {
  it("should write headings, paragraphs, lists, code and links as plain text", () => {
    const doc = {
      type: "doc",
      version: 1,
      content: [
        { type: "heading", attrs: { level: 2 }, content: [text("Steps")] },
        paragraph(text("Open "), { type: "inlineCard", attrs: { url: "https://x.y/z" } }, text(" as "), { type: "mention", attrs: { text: "@Dana" } }),
        { type: "orderedList", content: [item("Export"), item("Compare", { type: "bulletList", content: [item("rows"), item("columns")] })] },
        { type: "codeBlock", content: [text("npm test")] },
        paragraph(text("line one"), { type: "hardBreak" }, text("line two")),
      ],
    };

    expect(adfToText(doc)).toBe(
      ["## Steps", "", "Open https://x.y/z as @Dana", "", "1. Export", "2. Compare", "  - rows", "  - columns", "", "```", "npm test", "```", "", "line one", "line two"].join("\n"),
    );
  });

  it("should write a table one row per line", () => {
    const cell = (value: string) => ({ type: "tableCell", content: [paragraph(text(value))] });
    const doc = { type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [cell("a"), cell("b")] }] }] };

    expect(adfToText(doc)).toBe("| a | b |");
  });

  it("should give nothing for a missing or malformed description", () => {
    expect(adfToText(null)).toBe("");
    expect(adfToText("plain")).toBe("");
    expect(adfToText({ type: "doc", content: "nope" })).toBe("");
  });

  it("should skip odd nodes inside a description instead of throwing", () => {
    const doc = {
      type: "doc",
      content: [
        null,
        paragraph(text("kept"), { type: "date", attrs: { timestamp: "soon" } }),
        { type: "bulletList", content: [{ type: "listItem", content: "x" }, 7] },
        { type: "heading", attrs: { level: 1e9 }, content: [text("Big")] },
      ],
    };

    expect(adfToText(doc)).toBe("kept\n\n-\n\n###### Big");
  });
});
