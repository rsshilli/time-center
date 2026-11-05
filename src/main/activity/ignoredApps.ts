/** The setting that holds the ignored-apps list as JSON. */
export const IGNORED_APPS_SETTING = "ignoredApps";

/**
 * Edge in every channel, and its web apps: a bundle id also covers the ids under it. While an ignored
 * app is in front nothing about it is recorded, and no display showing one of its windows is photographed.
 */
export const DEFAULT_IGNORED_APPS: readonly string[] = ["com.microsoft.edgemac"];

/** The longest list the helper is handed, so a runaway setting can't make its command line huge. */
const MAX_ENTRIES = 50;

/**
 * Reads the stored ignored-apps list, falling back to the default when it is missing or damaged.
 * @param raw The setting's JSON, or null.
 * @returns The entries: bundle ids or app names.
 */
export function parseIgnoredApps(raw: string | null): string[] {
  if (raw === null) {
    return [...DEFAULT_IGNORED_APPS];
  }
  try {
    return assertIgnoredApps(JSON.parse(raw));
  } catch {
    return [...DEFAULT_IGNORED_APPS];
  }
}

/**
 * Checks a list from the renderer: text entries, trimmed, no commas (the helper's separator), no
 * duplicates. An empty list is allowed: it means nothing is ignored.
 * @param value The value.
 * @returns The cleaned entries.
 */
export function assertIgnoredApps(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("The ignored apps must be a list of app names or bundle ids.");
  }
  const entries = [...new Set((value as string[]).map((entry) => entry.trim()).filter((entry) => entry !== ""))];
  const withComma = entries.find((entry) => entry.includes(","));
  if (withComma) {
    throw new Error(`"${withComma}" has a comma in it; put each app on its own row.`);
  }
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`At most ${MAX_ENTRIES} ignored apps.`);
  }
  return entries;
}
