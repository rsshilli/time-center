import type { CategoryRule, RuleField } from "../../shared/ipc";

/** The category for time no rule matched. */
export const UNCATEGORIZED = "Uncategorized";

/** The category for time away from the keyboard. */
export const AWAY = "Away";

/** The category for time an ignored app (Edge) was in front. */
export const UNTRACKED = "Untracked";

/** The rules a new install starts with; the user edits them in Settings. */
export const STARTER_RULES: readonly CategoryRule[] = [
  { field: "app", pattern: "WebStorm", category: "Coding" },
  { field: "domain", pattern: "github.com", category: "Code review" },
  { field: "app", pattern: "Slack", category: "Communication" },
  { field: "domain", pattern: "mail.google.com", category: "Communication" },
  { field: "app", pattern: "zoom.us", category: "Meetings" },
  { field: "app", pattern: "Microsoft Teams", category: "Meetings" },
  { field: "domain", pattern: "meet.google.com", category: "Meetings" },
  { field: "domain", pattern: "teams.microsoft.com", category: "Meetings" },
  { field: "domain", pattern: "teams.live.com", category: "Meetings" },
];

/** The fields a rule can look at, for checking rules sent by the renderer. */
export const RULE_FIELDS: readonly RuleField[] = ["app", "domain", "url", "title", "project"];

/** JetBrains IDEs title their windows "project – file", with an en dash. */
const JETBRAINS_TITLE_SEPARATOR = " – ";

/** What a rule can be matched against. */
export interface Classifiable {
  app: string | null;
  domain: string | null;
  url: string | null;
  title: string | null;
  project: string | null;
}

/**
 * Picks the category for a stretch of active time: the first rule that matches, else Uncategorized.
 * @param item The stretch.
 * @param rules The rules, in order.
 * @returns The category.
 */
export function categorize(item: Classifiable, rules: readonly CategoryRule[]): string {
  const rule = rules.find((candidate) => ruleMatches(candidate, item));
  return rule ? rule.category : UNCATEGORIZED;
}

/**
 * Says whether one rule matches a stretch. Case is ignored; "domain" matches the site or a subdomain of
 * it, the other fields match when they contain the pattern. A blank pattern matches nothing.
 * @param rule The rule.
 * @param item The stretch.
 * @returns True on a match.
 */
export function ruleMatches(rule: CategoryRule, item: Classifiable): boolean {
  const pattern = rule.pattern.trim().toLowerCase();
  const value = item[rule.field]?.toLowerCase();
  if (!pattern || !value) {
    return false;
  }
  if (rule.field === "domain") {
    return value === pattern || value.endsWith(`.${pattern}`);
  }
  return value.includes(pattern);
}

/**
 * Reads the site out of a web address, without a leading "www.".
 * @param url The address, or null.
 * @returns e.g. "github.com", or null for no address or a non-web one.
 */
export function domainOf(url: string | null): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * Reads the project name out of a JetBrains IDE's window title ("time-center – PLAN.md").
 * @param bundleId The front app's bundle id.
 * @param title Its window title.
 * @returns The project name, or null for other apps and titles without one.
 */
export function projectOf(bundleId: string | null, title: string | null): string | null {
  if (!bundleId?.startsWith("com.jetbrains.") || !title) {
    return null;
  }
  const index = title.indexOf(JETBRAINS_TITLE_SEPARATOR);
  const project = (index === -1 ? title : title.slice(0, index)).trim();
  return project || null;
}

/**
 * Parses stored rules, falling back to the starter rules when none were saved or the text is damaged.
 * @param json The saved setting, or null.
 * @returns The rules.
 */
export function parseRules(json: string | null): CategoryRule[] {
  if (json === null) {
    return [...STARTER_RULES];
  }
  try {
    return assertRules(JSON.parse(json));
  } catch {
    return [...STARTER_RULES];
  }
}

/**
 * Checks that a value is a list of well-formed rules, as sent by the renderer or read from settings.
 * Trims each pattern and category.
 * @param value The value.
 * @returns The rules, typed.
 */
export function assertRules(value: unknown): CategoryRule[] {
  if (!Array.isArray(value)) {
    throw new Error("Rules must be a list.");
  }
  return value.map((entry, index) => {
    const rule = entry as Record<string, unknown> | null;
    if (
      !rule ||
      typeof rule !== "object" ||
      !RULE_FIELDS.includes(rule.field as RuleField) ||
      typeof rule.pattern !== "string" ||
      typeof rule.category !== "string" ||
      !rule.pattern.trim() ||
      !rule.category.trim()
    ) {
      throw new Error(`Rule ${index + 1} needs a field, a pattern and a category.`);
    }
    return { field: rule.field as RuleField, pattern: rule.pattern.trim(), category: rule.category.trim() };
  });
}
