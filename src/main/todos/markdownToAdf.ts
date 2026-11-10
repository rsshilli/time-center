import { marked, type Token, type Tokens } from "marked";

/** A node of Atlassian Document Format, the rich text Jira Cloud takes for descriptions and comments. */
export interface AdfNode {
  type: string;
  /** Only on the document itself: always 1. */
  version?: number;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: AdfMark[];
}

/** A text style in Atlassian Document Format: bold, italic, code, strike-through or a link. */
export interface AdfMark {
  type: "strong" | "em" | "code" | "strike" | "link";
  attrs?: { href: string };
}

/** Jira's limit on a ticket's summary. */
export const MAX_SUMMARY_CHARS = 255;

/**
 * Turns a TODO's Markdown into an Atlassian Document Format document, keeping bold, italics, code, links,
 * lists, headings, quotes and code blocks. Anything else (tables, HTML) comes through as plain text.
 * @param markdown The item.
 * @returns The document.
 */
export function markdownToAdf(markdown: string): AdfNode {
  return { type: "doc", version: 1, content: blocks(marked.lexer(markdown)) };
}

/**
 * The item's first line as plain text, for a ticket's summary.
 * @param markdown The item.
 * @returns Up to 255 characters, or "TODO" when the item has no words.
 */
export function summaryOf(markdown: string): string {
  const first = markdown
    .split("\n")
    .filter((line) => !/^\s*(?:```|~~~)/.test(line))
    .map((line) => line.replace(/^\s*(?:(?:[-*+]|\d+[.)]|#{1,6}|>)\s+)+/, "").trim())
    .find((line) => line.length > 0);
  if (!first) {
    return "TODO";
  }
  const text = decodeEntities(plainText(marked.Lexer.lexInline(first))).replace(/\s+/g, " ").trim();
  if (!text) {
    return "TODO";
  }
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…` : text;
}

/**
 * Converts block tokens (paragraphs, lists, …) to document nodes.
 * @param tokens The tokens.
 * @returns The nodes.
 */
function blocks(tokens: Token[]): AdfNode[] {
  return tokens.flatMap((token): AdfNode[] => {
    switch (token.type) {
      case "space":
      case "def":
        return [];
      case "paragraph":
      case "text":
        return [paragraph(inlineOf(token))];
      case "heading":
        return [{ type: "heading", attrs: { level: (token as Tokens.Heading).depth }, content: inlines((token as Tokens.Heading).tokens, []) }];
      case "list":
        return [list(token as Tokens.List)];
      case "blockquote":
        return [{ type: "blockquote", content: fitInside(blocks((token as Tokens.Blockquote).tokens)) }];
      case "code": {
        const code = token as Tokens.Code;
        return [{ type: "codeBlock", attrs: code.lang ? { language: code.lang } : {}, content: code.text ? [{ type: "text", text: code.text }] : [] }];
      }
      case "hr":
        return [{ type: "rule" }];
      default:
        return token.raw.trim() ? [paragraph([{ type: "text", text: token.raw.trim() }])] : [];
    }
  });
}

/**
 * A paragraph node.
 * @param content Its inline nodes.
 * @returns The node.
 */
function paragraph(content: AdfNode[]): AdfNode {
  return { type: "paragraph", content };
}

/**
 * The inline nodes of a paragraph or a list item's text, which may or may not have been split into tokens.
 * @param token The block token.
 * @returns Its inline nodes.
 */
function inlineOf(token: Token): AdfNode[] {
  const withTokens = token as Token & { tokens?: Token[]; text?: string };
  if (withTokens.tokens) {
    return inlines(withTokens.tokens, []);
  }
  return withTokens.text ? [{ type: "text", text: withTokens.text }] : [];
}

/**
 * A bullet or numbered list. Jira wants each item to start with a paragraph, which marked's items do.
 * @param token The list.
 * @returns The node.
 */
function list(token: Tokens.List): AdfNode {
  const items = token.items.map((item): AdfNode => {
    const content = fitInside(blocks(item.tokens));
    const prefix = item.task ? (item.checked ? "☑ " : "☐ ") : "";
    if (content[0]?.type !== "paragraph") {
      content.unshift(paragraph([]));
    }
    if (prefix) {
      content[0].content = [{ type: "text", text: prefix }, ...(content[0].content ?? [])];
    }
    return { type: "listItem", content };
  });
  if (token.ordered) {
    return { type: "orderedList", attrs: { order: Number(token.start) || 1 }, content: items };
  }
  return { type: "bulletList", content: items };
}

/**
 * Reshapes blocks to go inside a list item or a quote, where Jira allows only paragraphs, lists and code
 * blocks: a heading becomes a paragraph of its words, a quote gives up its contents, and a rule is dropped.
 * @param nodes The blocks.
 * @returns The blocks Jira accepts there.
 */
function fitInside(nodes: AdfNode[]): AdfNode[] {
  return nodes.flatMap((node): AdfNode[] => {
    switch (node.type) {
      case "heading":
        return [paragraph(node.content ?? [])];
      case "blockquote":
        return fitInside(node.content ?? []);
      case "rule":
        return [];
      default:
        return [node];
    }
  });
}

/**
 * Converts inline tokens to text nodes, carrying the styles of the tokens around them.
 * @param tokens The tokens.
 * @param marks The styles in force.
 * @returns The nodes; empty text is dropped, since Jira refuses it.
 */
function inlines(tokens: Token[], marks: AdfMark[]): AdfNode[] {
  return tokens.flatMap((token): AdfNode[] => {
    const nested = (token as { tokens?: Token[] }).tokens ?? [];
    switch (token.type) {
      case "strong":
        return inlines(nested, [...marks, { type: "strong" }]);
      case "em":
        return inlines(nested, [...marks, { type: "em" }]);
      case "del":
        return inlines(nested, [...marks, { type: "strike" }]);
      case "link": {
        const href = (token as Tokens.Link).href;
        const outside = marks.filter((mark) => mark.type !== "link");
        // Jira refuses a link with no address, so the words stay as plain text.
        return inlines(nested, href ? [...outside, { type: "link", attrs: { href } }] : outside);
      }
      case "codespan":
        // Jira lets code sit only beside a link, not bold or italics.
        return text((token as Tokens.Codespan).text, [...marks.filter((mark) => mark.type === "link"), { type: "code" }]);
      case "br":
        return [{ type: "hardBreak" }];
      case "image": {
        const image = token as Tokens.Image;
        return text(image.text || image.href, [...marks, { type: "link", attrs: { href: image.href } }]);
      }
      case "text":
        if (nested.length > 0) {
          return inlines(nested, marks);
        }
        return text(decodeEntities((token as Tokens.Text).text.replace(/\n/g, " ")), marks);
      default:
        return text(decodeEntities((token as { text?: string }).text ?? token.raw), marks);
    }
  });
}

/**
 * Turns HTML entities back into characters. The editor saves a typed & < > as &amp; &lt; &gt; and marked
 * leaves them as they are, so without this a ticket would read "R&amp;D".
 * @param value The text.
 * @returns The text with &amp;, &lt;, &gt;, &quot;, &#39; and numeric entities decoded.
 */
export function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (entity, decimal?: string, hex?: string, name?: string) => {
    const code = decimal ? Number(decimal) : hex ? Number.parseInt(hex, 16) : null;
    if (code !== null) {
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return named[(name ?? "").toLowerCase()] ?? entity;
  });
}

/**
 * A text node, or nothing for empty text.
 * @param value The text.
 * @param marks Its styles.
 * @returns The node in a list.
 */
function text(value: string, marks: AdfMark[]): AdfNode[] {
  if (!value) {
    return [];
  }
  return [marks.length > 0 ? { type: "text", text: value, marks } : { type: "text", text: value }];
}

/**
 * The words of inline tokens with the styling dropped.
 * @param tokens The tokens.
 * @returns The text.
 */
function plainText(tokens: Token[]): string {
  return tokens
    .map((token) => {
      const nested = (token as { tokens?: Token[] }).tokens;
      if (nested && nested.length > 0) {
        return plainText(nested);
      }
      if (token.type === "br") {
        return " ";
      }
      return (token as { text?: string }).text ?? token.raw;
    })
    .join("");
}
