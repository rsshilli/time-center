/** Colours for categories, picked by name so a category keeps its colour from day to day. */
const PALETTE = ["#2f6fed", "#1f8a4c", "#d9480f", "#7b3fe4", "#0c8599", "#c2255c", "#e8a33d", "#5c7cfa", "#37b24d", "#a61e4d"];

/** Fixed colours for the two kinds of time that aren't work. */
const FIXED_COLOURS: Record<string, string> = {
  Away: "#b8b8bd",
  Untracked: "#8e8e93",
  Uncategorized: "#9aa5b1",
};

/**
 * Picks a category's colour.
 * @param category The category name.
 * @returns A CSS colour.
 */
export function colourFor(category: string): string {
  const fixed = FIXED_COLOURS[category];
  if (fixed) {
    return fixed;
  }
  let hash = 0;
  for (const char of category) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

/**
 * Writes a length of time the way people say it.
 * @param ms Milliseconds.
 * @returns e.g. "2h 05m", "14m", "under a minute", or "0m" for none at all.
 */
export function formatDuration(ms: number): string {
  if (ms <= 0) {
    return "0m";
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return "under a minute";
  }
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

/**
 * Writes a clock time.
 * @param ms The moment.
 * @returns e.g. "9:31 AM".
 */
export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * Names a day relative to today.
 * @param dayStart The day's local midnight.
 * @param today Today's local midnight.
 * @returns "Today", "Yesterday", or e.g. "Monday, November 3".
 */
export function formatDay(dayStart: number, today: number): string {
  if (dayStart === today) {
    return "Today";
  }
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayStart === yesterday.getTime()) {
    return "Yesterday";
  }
  return new Date(dayStart).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}
