/** Blocks that end with a blank line, so paragraphs and headings stay apart. */
const BLOCKS = new Set(["paragraph", "heading", "blockquote", "codeBlock", "panel", "table", "mediaSingle", "rule"]);

/**
 * Turns a Jira description (Atlassian Document Format) into plain text a person or Claude can read: paragraphs
 * apart, list items with "- ", headings with "#", code in ``` fences, links and mentions as their text. Nodes that
 * aren't shaped like nodes are skipped, so an odd description never throws.
 * @param doc The description as Jira sent it; anything that isn't a document gives "".
 * @returns The text, trimmed.
 */
export function adfToText(doc: unknown): string {
  if (!isNode(doc)) {
    return "";
  }
  return writeNode(doc, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A node as read from Jira, checked only as far as it is used. */
interface AdfLike {
  type: string;
  text?: unknown;
  attrs?: Record<string, unknown>;
  content?: unknown;
}

/**
 * Whether a value is shaped like a document node.
 * @param value The value.
 * @returns True when it is an object with a type.
 */
function isNode(value: unknown): value is AdfLike {
  return typeof (value as AdfLike | null)?.type === "string";
}

/**
 * Writes one node and what is inside it.
 * @param node The node.
 * @param indent What each new line inside a list starts with.
 * @returns Its text.
 */
function writeNode(node: AdfLike, indent: string): string {
  switch (node.type) {
    case "text":
      return typeof node.text === "string" ? node.text : "";
    case "hardBreak":
      return `\n${indent}`;
    case "mention":
    case "emoji":
    case "status":
      return String(node.attrs?.text ?? node.attrs?.shortName ?? "");
    case "inlineCard":
    case "blockCard":
      return String(node.attrs?.url ?? "");
    case "date":
      return formatDate(node.attrs?.timestamp);
    case "heading":
      return `${"#".repeat(Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)))} ${children(node, indent)}\n\n`;
    case "codeBlock":
      return `\`\`\`\n${children(node, indent)}\n\`\`\`\n\n`;
    case "rule":
      return "---\n\n";
    case "bulletList":
    case "orderedList":
      return `${listItems(node, indent)}\n`;
    case "tableRow":
      return `| ${contentOf(node).map((cell) => children(cell, indent).replace(/\n+/g, " ").trim()).join(" | ")} |\n`;
    default:
      return BLOCKS.has(node.type) ? `${children(node, indent)}\n\n` : children(node, indent);
  }
}

/**
 * A date node's day, as Jira keeps it (milliseconds, as text).
 * @param timestamp The node's timestamp.
 * @returns The day as "2026-11-16", or "" when it isn't a time.
 */
function formatDate(timestamp: unknown): string {
  const time = new Date(Number(timestamp));
  return Number.isNaN(time.getTime()) ? "" : time.toISOString().slice(0, 10);
}

/**
 * The text of a node's children, joined.
 * @param node The node.
 * @param indent Passed down to lists inside it.
 * @returns The text.
 */
function children(node: AdfLike, indent: string): string {
  return contentOf(node)
    .map((child) => writeNode(child, indent))
    .join("");
}

/**
 * The items of a bulleted or numbered list, one per line, nested lists indented under their item.
 * @param list The list.
 * @param indent What its lines start with.
 * @returns The lines.
 */
function listItems(list: AdfLike, indent: string): string {
  const numbered = list.type === "orderedList";
  const inner = `${indent}  `;
  return contentOf(list)
    .map((item, index) => {
      const marker = numbered ? `${index + 1}. ` : "- ";
      // A nested list writes its own lines, already indented; other parts sit on the item's lines.
      const parts = contentOf(item).map((part) =>
        part.type === "bulletList" || part.type === "orderedList" ? listItems(part, inner).trimEnd() : `${inner}${writeNode(part, inner).trim()}`,
      );
      return `${indent}${marker}${parts.join("\n").slice(inner.length)}\n`;
    })
    .join("");
}

/**
 * A node's children that are shaped like nodes.
 * @param node The node.
 * @returns Them, or none when its content isn't a list.
 */
function contentOf(node: AdfLike): AdfLike[] {
  return Array.isArray(node.content) ? node.content.filter(isNode) : [];
}
