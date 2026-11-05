import type { CategoryRule, RuleField, TimelineItem } from "../shared/ipc";

/** The category the main process gives time no rule matched. */
export const UNCATEGORIZED = "Uncategorized";

/** How many window titles each group shows as examples of what's in it. */
const EXAMPLE_COUNT = 3;

/** The fields a rule can match, in the order a suggestion prefers them: the narrowest useful one first. */
const SUGGESTION_ORDER: readonly RuleField[] = ["domain", "project", "app"];

/** One thing that took uncategorized time, with the rule that would sort it. */
export interface UncategorizedGroup {
  /** The field the suggested rule looks at. */
  field: RuleField;
  /** What the suggested rule matches, e.g. "github.com". */
  pattern: string;
  /** How long it took today, in milliseconds. */
  ms: number;
  /** Its longest stretch, whose values fill in the rule when the user picks another field. */
  sample: TimelineItem;
  /** Its window titles that took the most time, longest first. */
  examples: string[];
}

/**
 * Groups a day's uncategorized time by the website, WebStorm project or app it was spent in, largest
 * first, so each group can become one rule.
 * @param timeline The day's stretches.
 * @returns One group per thing, largest first.
 */
export function uncategorizedGroups(timeline: readonly TimelineItem[]): UncategorizedGroup[] {
  const groups = new Map<string, { group: UncategorizedGroup; titles: Map<string, number> }>();
  for (const item of timeline) {
    const match = item.kind === "active" && item.category === UNCATEGORIZED ? suggestedMatch(item) : null;
    if (!match) {
      continue;
    }
    const ms = item.end - item.start;
    const key = `${match.field}\n${match.pattern.toLowerCase()}`;
    let entry = groups.get(key);
    if (!entry) {
      entry = { group: { ...match, ms: 0, sample: item, examples: [] }, titles: new Map() };
      groups.set(key, entry);
    }
    entry.group.ms += ms;
    if (ms > entry.group.sample.end - entry.group.sample.start) {
      entry.group.sample = item;
    }
    if (item.title) {
      entry.titles.set(item.title, (entry.titles.get(item.title) ?? 0) + ms);
    }
  }
  return [...groups.values()]
    .map(({ group, titles }) => ({ ...group, examples: topTitles(titles) }))
    .sort((a, b) => b.ms - a.ms);
}

/**
 * Lists the category names the rules already use, for picking one instead of typing it.
 * @param rules The rules.
 * @returns Each name once, in alphabetical order.
 */
export function knownCategories(rules: readonly CategoryRule[]): string[] {
  return [...new Set(rules.map((rule) => rule.category))].sort((a, b) => a.localeCompare(b));
}

/**
 * Picks the rule that would sort a stretch: its website, else its WebStorm project, else its app. A
 * browser is never one thing, so browser time without a website is matched by its page title instead.
 * @param item The stretch.
 * @returns The field and pattern, or null when the stretch has none of them.
 */
function suggestedMatch(item: TimelineItem): { field: RuleField; pattern: string } | null {
  if (!item.domain?.trim() && isBrowser(item.app)) {
    const page = pageTitle(item.title);
    return page ? { field: "title", pattern: page } : null;
  }
  for (const field of SUGGESTION_ORDER) {
    const value = item[field]?.trim();
    if (value) {
      return { field, pattern: value };
    }
  }
  return null;
}

/**
 * Says whether an app is a web browser, whose time belongs to its pages rather than to the app.
 * @param app The app's name.
 * @returns True for Chrome (the only browser tracked; Chrome web apps such as Google Chat have their own names).
 */
function isBrowser(app: string | null): boolean {
  return app === "Google Chrome";
}

/**
 * Strips what Chrome adds to a window title (" - Google Chrome - Ryan (qbdvision.com)", " - Pinned",
 * " - High memory usage…"), leaving the page's own title.
 * @param title The window title.
 * @returns The page title, or null when nothing is left.
 */
export function pageTitle(title: string | null): string | null {
  const page = title
    ?.replace(/ - Google Chrome( - .*)?$/, "")
    .replace(/ - (Pinned|High memory usage.*|Camera and microphone.*|Audio playing.*)$/, "")
    .trim();
  return page || null;
}

/**
 * Picks the window titles that took the most time.
 * @param titles Time per title.
 * @returns Up to EXAMPLE_COUNT titles, longest first.
 */
function topTitles(titles: Map<string, number>): string[] {
  return [...titles.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, EXAMPLE_COUNT)
    .map(([title]) => title);
}
