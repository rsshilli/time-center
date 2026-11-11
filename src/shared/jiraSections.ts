/** A section a type of Jira ticket must have in its description, as the QI team writes it. */
interface RequiredSection {
  heading: string;
  /** What goes under the heading when nothing has been written yet. */
  placeholder: string;
  /** Heading words that count as this section, besides its own, e.g. "Expected" and "Actual" written apart. */
  alsoKnownAs: string[][];
}

/** What's written under a required heading until someone fills it in. */
export const TO_BE_WRITTEN = "To be written.";

/** A story's section. */
const ACCEPTANCE: RequiredSection = { heading: "Acceptance Criteria", placeholder: `- ${TO_BE_WRITTEN}`, alsoKnownAs: [] };

/** A bug's sections. A blank line between Expected and Actual, or Jira joins them into one line. */
const STEPS: RequiredSection = { heading: "Steps to reproduce", placeholder: `1. ${TO_BE_WRITTEN}`, alsoKnownAs: [["reproduction steps"], ["repro steps"]] };
const EXPECTED_ACTUAL: RequiredSection = {
  heading: "Expected / Actual",
  placeholder: `Expected: ${TO_BE_WRITTEN}\n\nActual: ${TO_BE_WRITTEN}`,
  alsoKnownAs: [["expected vs actual"], ["expected", "actual"]],
};

/**
 * The sections a type of ticket's description must have: stories need acceptance criteria; bugs need the steps
 * to reproduce and the expected and actual outcome. Matched on the type's name, so "Story (FRS)" is a story.
 * @param issueType The type, e.g. "Story (FRS)".
 * @returns The sections, in the order they go; none for other types.
 */
export function requiredSections(issueType: string): RequiredSection[] {
  if (/\bstory\b/i.test(issueType)) {
    return [ACCEPTANCE];
  }
  if (/\bbug\b/i.test(issueType)) {
    return [STEPS, EXPECTED_ACTUAL];
  }
  return [];
}

/**
 * Fits a description to a type of ticket: takes out another type's sections that were never filled in (only
 * "To be written."), then adds any section this type needs that isn't there yet, at the end, with a placeholder.
 * @param markdown The description.
 * @param issueType The type of ticket.
 * @returns The description with every required section.
 */
export function withRequiredSections(markdown: string, issueType: string): string {
  const required = requiredSections(issueType);
  const others = [ACCEPTANCE, STEPS, EXPECTED_ACTUAL].filter((section) => !required.includes(section));
  let text = others.reduce((current, section) => withoutPlaceholder(current, section), markdown);
  const headings = headingsOf(text);
  const missing = required.filter((section) => !hasSection(headings, section));
  if (missing.length === 0) {
    return text;
  }
  const added = missing.map((section) => `## ${section.heading}\n${section.placeholder}`).join("\n\n");
  text = text.trimEnd();
  return text === "" ? added : `${text}\n\n${added}`;
}

/**
 * The headings in a description, as words: Markdown headings of any level and lines that are wholly bold,
 * leaving out anything inside a fenced code block.
 * @param markdown The description.
 * @returns Each heading's words.
 */
function headingsOf(markdown: string): string[] {
  const headings: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    const heading = fenced ? null : (/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line) ?? /^\s{0,3}(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*$/.exec(line));
    if (heading) {
      headings.push(tidy(heading[1]));
    }
  }
  return headings;
}

/**
 * Whether a description has a section: a heading that starts with its name or one of its other names; a name
 * written as two headings ("Expected", then "Actual") needs both.
 * @param headings The description's headings, as words.
 * @param section The section.
 * @returns True when it's there.
 */
function hasSection(headings: string[], section: RequiredSection): boolean {
  const names = [[section.heading], ...section.alsoKnownAs].map((parts) => parts.map(tidy));
  return names.some((parts) => parts.every((part) => headings.some((heading) => heading === part || heading.startsWith(`${part} `))));
}

/**
 * Takes a section out of a description when it still holds only its placeholder, as added when the type was
 * different.
 * @param markdown The description.
 * @param section The section.
 * @returns The description without it.
 */
function withoutPlaceholder(markdown: string, section: RequiredSection): string {
  const block = `## ${section.heading}\n${section.placeholder}`;
  if (!markdown.includes(block)) {
    return markdown;
  }
  return markdown
    .replace(`\n\n${block}`, "")
    .replace(block, "")
    .replace(/^\n+/, "");
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
