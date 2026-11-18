import { MAX_RANGE_DAYS, type RangeReport, type Todo, type Total } from "../../shared/ipc";
import type { StoredSegment } from "../activity/ActivityStore";
import { localDayBounds } from "../activity/dayReport";
import type { HaikuClient } from "../calendar/BedrockHaiku";
import type { TicketActivity, TicketActivityReport } from "../todos/jira";

/** The stretch of time a question is about, from local midnight to local midnight. */
export interface WorkPeriod {
  from: number;
  to: number;
}

/** Days covered when a question doesn't name a stretch of time. */
export const DEFAULT_PERIOD_DAYS = 7;

/** The most window titles listed, most time first. */
export const MAX_TITLES = 80;

/** The longest window title kept. */
const MAX_TITLE_CHARS = 150;

/** A window shown for less than this isn't listed by title. */
const MIN_TITLE_MS = 60_000;

/** Rows kept from each of the time report's lists. */
const MAX_TOTALS = 12;

/** The tool Haiku answers through. */
const PERIOD_TOOL = "set_period";

/** How Haiku should read a question's dates. */
const PERIOD_PROMPT =
  "You read which stretch of days a question about the user's own work is about, as calendar dates. Weeks start on " +
  'Monday, so "last week" is the Monday to Sunday before this week and "this week" is Monday to today. ' +
  'When the question names no time at all ("what did I work on?"), set about_a_period to false.';

/** The tool's shape. */
const PERIOD_TOOL_SCHEMA = {
  name: PERIOD_TOOL,
  description: "Records the stretch of days the question is about.",
  input_schema: {
    type: "object",
    properties: {
      about_a_period: { type: "boolean", description: "Whether the question names a time, e.g. yesterday, last week, in October." },
      from: { type: "string", description: "First day, YYYY-MM-DD." },
      to: { type: "string", description: "Last day, YYYY-MM-DD, included." },
    },
    required: ["about_a_period"],
  },
};

/** What the work log is made from, injected for tests. */
export interface WorkLogDeps {
  /** Your tracked time over the days, as the My time tab adds it up. */
  range(from: number, to: number): RangeReport;
  /** The front windows in a stretch. */
  segments(from: number, to: number): StoredSegment[];
  /** Every TODO, done or not. */
  todos(): Todo[];
  /** Your Jira tickets that moved in a stretch. */
  tickets(from: number, to: number): Promise<TicketActivityReport>;
}

/**
 * Asks Haiku which days a question is about. Unreadable dates, a stretch that ends before it starts, or one
 * longer than the time report can add up read as no stretch; one running past today stops at today.
 * @param haiku Claude Haiku.
 * @param question The question.
 * @param now The current time.
 * @returns The stretch, or null when the question doesn't name one (or Haiku couldn't be asked).
 */
export async function askPeriod(haiku: Pick<HaikuClient, "invoke">, question: string, now: number): Promise<WorkPeriod | null> {
  let reply: unknown;
  try {
    reply = await haiku.invoke(buildPeriodRequest(question, now));
  } catch {
    return null;
  }
  return readPeriod(reply, now);
}

/**
 * Builds the request asking Haiku for a question's dates.
 * @param question The question.
 * @param now The current time.
 * @returns The Messages API body.
 */
export function buildPeriodRequest(question: string, now: number): object {
  const today = new Date(now).toLocaleDateString("en-CA");
  const weekday = new Date(now).toLocaleDateString("en-US", { weekday: "long" });
  return {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 200,
    system: PERIOD_PROMPT,
    tools: [PERIOD_TOOL_SCHEMA],
    tool_choice: { type: "tool", name: PERIOD_TOOL },
    messages: [{ role: "user", content: `Today is ${weekday}, ${today}.\n\nQuestion: ${question}` }],
  };
}

/**
 * Reads the stretch out of Haiku's tool call.
 * @param reply The parsed Messages API reply.
 * @param now The current time.
 * @returns The stretch, or null.
 */
export function readPeriod(reply: unknown, now: number): WorkPeriod | null {
  const content = (reply as { content?: { type?: unknown; name?: unknown; input?: unknown }[] } | null)?.content;
  const call = Array.isArray(content) ? content.find((block) => block.type === "tool_use" && block.name === PERIOD_TOOL) : undefined;
  const input = call?.input as { about_a_period?: unknown; from?: unknown; to?: unknown } | undefined;
  if (!input || input.about_a_period !== true) {
    return null;
  }
  const first = localDate(input.from);
  const last = localDate(input.to ?? input.from);
  if (first === null || last === null || last < first) {
    return null;
  }
  const from = localDayBounds(first).dayStart;
  const to = Math.min(localDayBounds(last).dayEnd, localDayBounds(now).dayEnd);
  if (to <= from || (to - from) / 86_400_000 > MAX_RANGE_DAYS) {
    return null;
  }
  return { from, to };
}

/**
 * Reads a YYYY-MM-DD date as local midnight.
 * @param value The date.
 * @returns The moment, or null when it isn't one.
 */
function localDate(value: unknown): number | null {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim()) : null;
  if (!match) {
    return null;
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getDate() === Number(match[3]) ? date.getTime() : null;
}

/**
 * The last few days up to today, for a question that names no stretch.
 * @param now The current time.
 * @returns The stretch.
 */
export function defaultPeriod(now: number): WorkPeriod {
  const to = localDayBounds(now).dayEnd;
  const start = new Date(localDayBounds(now).dayStart);
  start.setDate(start.getDate() - (DEFAULT_PERIOD_DAYS - 1));
  return { from: start.getTime(), to };
}

/**
 * Writes what you did in a stretch for Sonnet: your tracked time, the windows you spent it in, the TODOs you
 * added and ticked, and the Jira tickets of yours that moved.
 * @param deps The time tracker, the TODO list and Jira.
 * @param period The stretch.
 * @returns The log, wrapped in a <work_log> tag.
 */
export async function buildWorkLog(deps: WorkLogDeps, period: WorkPeriod): Promise<string> {
  const { from, to } = period;
  const tickets = await deps.tickets(from, to);
  const sections = [
    timeSection(deps.range(from, to)),
    titlesSection(deps.segments(from, to)),
    todosSection(deps.todos(), period),
    ticketsSection(tickets),
  ];
  return `<work_log from="${longDate(from)}" to="${longDate(to - 1)}">\n${sections.join("\n\n")}\n</work_log>`;
}

/**
 * Writes the time report's totals.
 * @param report The days added up.
 * @returns The section.
 */
function timeSection(report: RangeReport): string {
  const lines = [
    "Tracked computer time (from the app's time tracker):",
    `- Active ${duration(report.activeMs)}, idle ${duration(report.idleMs)}, untracked ${duration(report.untrackedMs)}.`,
    `- By day: ${report.days.map((day) => `${shortDate(day.dayStart)} ${duration(day.activeMs)}`).join(", ")}.`,
    totalsLine("By category", report.byCategory),
    totalsLine("By project", report.byProject),
    totalsLine("By app", report.byApp),
    totalsLine("By website", report.byDomain),
    totalsLine("Meetings attended", report.byMeeting),
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

/**
 * Writes one of the report's lists on one line, most time first.
 * @param label What it is.
 * @param totals The list.
 * @returns The line, or null when the list is empty.
 */
function totalsLine(label: string, totals: readonly Total[]): string | null {
  const kept = [...totals].sort((a, b) => b.ms - a.ms).slice(0, MAX_TOTALS);
  return kept.length === 0 ? null : `- ${label}: ${kept.map((total) => `${total.name} ${duration(total.ms)}`).join("; ")}.`;
}

/**
 * Lists the windows you were in longest, by app and title, since a title (a pull request, a ticket, a document)
 * says what the time went on.
 * @param segments The front windows.
 * @returns The section.
 */
export function titlesSection(segments: readonly StoredSegment[]): string {
  const totals = new Map<string, { app: string; title: string; domain: string | null; ms: number }>();
  for (const segment of segments) {
    const title = segment.title?.replace(/\s+/g, " ").trim();
    if (segment.kind !== "active" || !title) {
      continue;
    }
    const app = segment.app ?? "";
    const key = `${app}\n${title}`;
    const total = totals.get(key) ?? { app, title: title.slice(0, MAX_TITLE_CHARS), domain: segment.domain, ms: 0 };
    total.ms += segment.endedAt - segment.startedAt;
    totals.set(key, total);
  }
  const kept = [...totals.values()]
    .filter((total) => total.ms >= MIN_TITLE_MS)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, MAX_TITLES);
  const heading = "Window titles, most time first (ticket keys such as QI-123 and pull request titles say what was worked on):";
  if (kept.length === 0) {
    return `${heading}\n- None tracked.`;
  }
  const rows = kept.map((total) => `- ${duration(total.ms)} · ${total.app} · ${total.title}${total.domain ? ` (${total.domain})` : ""}`);
  return `${heading}\n${rows.join("\n")}`;
}

/**
 * Lists the TODOs added and the ones ticked in a stretch.
 * @param todos Every TODO.
 * @param period The stretch.
 * @returns The section.
 */
export function todosSection(todos: readonly Todo[], period: WorkPeriod): string {
  const within = (at: number | null) => at !== null && at >= period.from && at < period.to;
  const line = (todo: Todo) => `- ${todo.markdown.replace(/\s+/g, " ").trim().slice(0, 200)}`;
  const done = todos.filter((todo) => within(todo.doneAt));
  const added = todos.filter((todo) => within(todo.createdAt) && !within(todo.doneAt));
  return [
    "TODOs ticked done in this stretch:",
    ...(done.length === 0 ? ["- None."] : done.map(line)),
    "TODOs added in this stretch and not yet done:",
    ...(added.length === 0 ? ["- None."] : added.map(line)),
  ].join("\n");
}

/**
 * Lists the Jira tickets of yours that moved, with each status change and who made it.
 * @param report The tickets, or why Jira couldn't be read.
 * @returns The section.
 */
export function ticketsSection(report: TicketActivityReport): string {
  const heading = "Jira tickets assigned to you (now or before) whose status changed in this stretch, or that you created:";
  if (report.problem !== null) {
    return `${heading}\n- Couldn't read Jira: ${report.problem}`;
  }
  if (report.tickets.length === 0) {
    return `${heading}\n- None.`;
  }
  return `${heading}\n${report.tickets.map(ticketLine).join("\n")}`;
}

/**
 * Writes one ticket's line.
 * @param ticket The ticket.
 * @returns e.g. "- QI-1 (Task) "Fix it", now Merged to Master. Nov 13: In Draft → In Testing (by Ryan)."
 */
function ticketLine(ticket: TicketActivity): string {
  const parts = [`- ${ticket.key} (${ticket.type || "ticket"}) "${ticket.summary}", now ${ticket.status || "unknown"}.`];
  if (ticket.createdByYouAt !== null) {
    parts.push(`You created it ${shortDate(ticket.createdByYouAt)}.`);
  }
  for (const move of ticket.moves) {
    parts.push(`${shortDate(move.at)}: ${move.from} → ${move.to} (by ${move.by}).`);
  }
  return parts.join(" ");
}

/**
 * Writes a length of time in hours and minutes.
 * @param ms The time.
 * @returns e.g. "3h 05m", or "12m".
 */
export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${minutes}m` : `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Writes a day briefly.
 * @param ms A moment in it.
 * @returns e.g. "Mon Nov 9".
 */
function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).replace(",", "");
}

/**
 * Writes a date in full.
 * @param ms A moment in it.
 * @returns e.g. "Monday, November 9, 2026".
 */
function longDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}
