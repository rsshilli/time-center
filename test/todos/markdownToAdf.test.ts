import { MAX_SUMMARY_CHARS, markdownToAdf, summaryOf } from "../../src/main/todos/markdownToAdf";

describe("markdownToAdf", () => {
  it("should keep bold, italics, strike-through, code and links as Jira marks", () => {
    expect(markdownToAdf("Send **Dana** the [keys & certs](https://x.y/?a=1&b=2), `a<b` ~~no~~ *now*")).toEqual({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Send " },
            { type: "text", text: "Dana", marks: [{ type: "strong" }] },
            { type: "text", text: " the " },
            { type: "text", text: "keys & certs", marks: [{ type: "link", attrs: { href: "https://x.y/?a=1&b=2" } }] },
            { type: "text", text: ", " },
            { type: "text", text: "a<b", marks: [{ type: "code" }] },
            { type: "text", text: " " },
            { type: "text", text: "no", marks: [{ type: "strike" }] },
            { type: "text", text: " " },
            { type: "text", text: "now", marks: [{ type: "em" }] },
          ],
        },
      ],
    });
  });

  it("should keep nested lists, numbered lists, headings, quotes, code blocks and rules", () => {
    const doc = markdownToAdf("# Plan\n\n- one\n- two\n  - nested\n\n3. three\n\n> quoted\n\n```js\nx < 1\n```\n\n---");
    expect(doc.content?.map((node) => node.type)).toEqual(["heading", "bulletList", "orderedList", "blockquote", "codeBlock", "rule"]);
    expect(doc.content?.[0]).toEqual({ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Plan" }] });
    expect(doc.content?.[1].content?.[1]).toEqual({
      type: "listItem",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "two" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "nested" }] }] }] },
      ],
    });
    expect(doc.content?.[2].attrs).toEqual({ order: 3 });
    expect(doc.content?.[4]).toEqual({ type: "codeBlock", attrs: { language: "js" }, content: [{ type: "text", text: "x < 1" }] });
  });

  it("should never make an empty text node, which Jira refuses", () => {
    const json = JSON.stringify(markdownToAdf("**\n\n- \n\n``\n\nplain"));
    expect(json).not.toContain('"text":""');
  });

  it("should let code sit inside a link but drop bold around it, as Jira requires", () => {
    const [paragraph] = markdownToAdf("**[`npm test`](https://x.y)**").content ?? [];
    expect(paragraph.content?.[0].marks).toEqual([{ type: "link", attrs: { href: "https://x.y" } }, { type: "code" }]);
  });

  it("should turn the entities the editor saves back into the characters typed", () => {
    expect(markdownToAdf("R&amp;D a&lt;b x&gt;y").content).toEqual([{ type: "paragraph", content: [{ type: "text", text: "R&D a<b x>y" }] }]);
  });

  it("should only put paragraphs, lists and code inside list items and quotes, as Jira requires", () => {
    const json = JSON.stringify(markdownToAdf("- # head\n- a\n\n  > q\n\n  ---\n\n> # h\n> > deeper"));
    const inside = (type: string) => JSON.stringify(JSON.parse(json).content.filter((node: { type: string }) => node.type === type));
    expect(inside("bulletList")).not.toMatch(/"heading"|"blockquote"|"rule"/);
    expect(inside("blockquote")).not.toMatch(/"heading"|"rule"/);
    expect(inside("blockquote").match(/"blockquote"/g)).toHaveLength(1);
    expect(json).toContain('"text":"head"');
    expect(json).toContain('"text":"deeper"');
  });

  it("should leave a link with no address as plain words", () => {
    expect(markdownToAdf("[x]()").content).toEqual([{ type: "paragraph", content: [{ type: "text", text: "x" }] }]);
  });
});

describe("summaryOf", () => {
  it("should use the first line with words, without its formatting", () => {
    expect(summaryOf("\n\n- **Send** Dana the [keys](https://x.y)\nmore")).toBe("Send Dana the keys");
    expect(summaryOf("## Review `PR 485`")).toBe("Review PR 485");
    expect(summaryOf("- # head")).toBe("head");
    expect(summaryOf("```\nnpm test\n```")).toBe("npm test");
  });

  it("should show a typed & < > as themselves, not as the entities the editor saves", () => {
    expect(summaryOf("R&amp;D sync &lt;today&gt;")).toBe("R&D sync <today>");
  });

  it("should cut a long line to Jira's limit and fall back to TODO when there are no words", () => {
    expect(summaryOf("x".repeat(400))).toHaveLength(MAX_SUMMARY_CHARS);
    expect(summaryOf("  \n ")).toBe("TODO");
  });
});
