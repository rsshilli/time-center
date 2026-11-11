/** A section a type of Jira ticket must have in its description, as the QI team writes it. */
interface RequiredSection {
  heading: string;
  /** What goes under the heading when nothing has been written yet. */
  placeholder: string;
}

/** What's written under a required heading until someone fills it in. */
export const TO_BE_WRITTEN = "To be written.";

/**
 * The sections a type of ticket's description must have: stories need acceptance criteria; bugs need the steps
 * to reproduce and the expected and actual outcome. Matched on the type's name, so "Story (FRS)" is a story.
 * @param issueType The type, e.g. "Story (FRS)".
 * @returns The sections, in the order they go; none for other types.
 */
export function requiredSections(issueType: string): RequiredSection[] {
  if (/\bstory\b/i.test(issueType)) {
    return [{ heading: "Acceptance Criteria", placeholder: `- ${TO_BE_WRITTEN}` }];
  }
  if (/\bbug\b/i.test(issueType)) {
    return [
      { heading: "Steps to reproduce", placeholder: `1. ${TO_BE_WRITTEN}` },
      // A blank line between them, or Jira joins them into one line.
      { heading: "Expected / Actual", placeholder: `Expected: ${TO_BE_WRITTEN}\n\nActual: ${TO_BE_WRITTEN}` },
    ];
  }
  return [];
}

/**
 * Adds any section a type of ticket needs that the description doesn't have yet, at the end, with a placeholder
 * under it. A section counts as there when a Markdown heading of any level has its name, in any case.
 * @param markdown The description.
 * @param issueType The type of ticket.
 * @returns The description with every required section.
 */
export function withRequiredSections(markdown: string, issueType: string): string {
  const headings = [...markdown.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((match) => tidy(match[1]));
  const missing = requiredSections(issueType).filter((section) => !headings.includes(tidy(section.heading)));
  if (missing.length === 0) {
    return markdown;
  }
  const added = missing.map((section) => `## ${section.heading}\n${section.placeholder}`).join("\n\n");
  return markdown.trim() === "" ? added : `${markdown.trimEnd()}\n\n${added}`;
}

/**
 * A heading reduced to its words, so "Expected/Actual:" and "expected / actual" match.
 * @param heading The heading.
 * @returns Its letters and spaces, in lower case.
 */
function tidy(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();
}
