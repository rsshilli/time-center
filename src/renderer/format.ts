import { meetingCategory } from "../shared/ipc";

/**
 * Colours for categories nobody gave one, picked by name so a category keeps its colour from day to day. No
 * greens: green means a meeting.
 */
const PALETTE = ["#0b7285", "#862e9c", "#a61e4d", "#e67700", "#1864ab", "#5f3dc4"];

/**
 * Fixed colours, so two very different kinds of work can't land on the same colour by chance (Coding and
 * Communication once both hashed to orange). Meetings are all shades of green; nothing else is green.
 */
const FIXED_COLOURS: Record<string, string> = {
  Away: "#b8b8bd",
  Untracked: "#8e8e93",
  Uncategorized: "#9aa5b1",
  Coding: "#1c7ed6",
  Communication: "#f76707",
  "Code review": "#ae3ec9",
  Personal: "#e03131",
  Research: "#15aabf",
  Learning: "#fcc419",
  Testing: "#f06595",
  "Team Management": "#8d6e63",
  "Time Management": "#364fc7",
  "IT Administrator Duties": "#495057",
  Other: "#c8a27a",
  [meetingCategory(null)]: "#51cf66",
  [meetingCategory("one-on-one")]: "#2b8a3e",
  [meetingCategory("dsu")]: "#94d82d",
  [meetingCategory("management")]: "#087f5b",
  [meetingCategory("architecture")]: "#20c997",
  [meetingCategory("customer")]: "#5c940d",
  [meetingCategory("other")]: "#8ce99a",
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
