import { basename, join } from "node:path";
import { COWORK_URL, type QbdcodeHandoff, type TicketBrief, type TicketSends, type TicketWorktrees, type TodoSent } from "../../shared/ipc";
import type { Store } from "../store/Store";
import { cutText, type HandoffDependencies, listWorktrees, MAX_COWORK_CHARS, QBDVISION_REPO, sendToQbdcode, shortBranch, withPlanFirst } from "./handoff";
import { assertTicketKeys } from "./jira";

/** Where the record of sent tickets is kept in the settings table, as JSON. */
export const TICKET_SENDS_KEY = "jira.ticketSends";

/** The most sends remembered per ticket. */
export const MAX_SENDS_PER_TICKET = 5;

/** The most tickets whose sends are remembered; the ones sent longest ago are forgotten first. */
export const MAX_TICKETS_REMEMBERED = 200;

/** The most of one ticket's description handed over, so a long one leaves room for the others. */
export const MAX_DESCRIPTION_CHARS = 6_000;

/** What the ticket hand-off reads and does. */
export interface TicketHandoffDependencies {
  handoff: HandoffDependencies;
  /** Reads the tickets from Jira. */
  readTickets(keys: string[]): Promise<TicketBrief[]>;
  settings: Pick<Store, "getSetting" | "setSetting">;
  /** Moves tickets not started yet to In Testing / Development once they're handed to QbDCode; never throws. */
  startTickets(keys: string[]): Promise<{ moved: string[]; problems: string[] }>;
  /** Whether Claude Desktop, which opens the Cowork link, is installed. */
  coworkInstalled(): boolean;
  now(): number;
}

/** The TODO tab's ticket requests, as the IPC answers them. */
export interface TicketHandoffApi {
  getTicketSends(): TicketSends;
  getTicketWorktrees(): TicketWorktrees;
  sendTicketsToCowork(keys: unknown): Promise<TicketSends>;
  prepareTicketsQbdcode(keys: unknown): Promise<QbdcodeHandoff>;
  sendTicketsToQbdcode(keys: unknown, path: unknown, text: unknown): Promise<TicketSends>;
}

/**
 * Sending Jira tickets from the TODO tab to Claude, the way a TODO is sent: a new Cowork task, or one QbDCode chat
 * on all the tickets picked. Each send is remembered against every ticket in it. A ticket handed to QbDCode that
 * hasn't been started yet is moved to In Testing / Development, since QbDCode is now working on it.
 * @param deps What it reads and does.
 * @returns The requests.
 */
export function ticketHandoff(deps: TicketHandoffDependencies): TicketHandoffApi {
  return {
    getTicketSends: () => readTicketSends(deps.settings),
    getTicketWorktrees: () => ticketWorktrees(deps.handoff.home),
    sendTicketsToCowork: async (keys) => {
      const checked = assertTicketKeys(keys);
      if (!deps.coworkInstalled()) {
        throw new Error("Install Claude Desktop first");
      }
      const tickets = await deps.readTickets(checked);
      const text = cutText(ticketsHandoffText(tickets), MAX_COWORK_CHARS);
      await deps.handoff.openExternal(`claude://cowork/new?q=${encodeURIComponent(text)}`);
      return recordTicketSends(deps, tickets.map((ticket) => ticket.key), { action: "cowork", label: "Claude Cowork", url: COWORK_URL });
    },
    prepareTicketsQbdcode: async (keys) => {
      const tickets = await deps.readTickets(assertTicketKeys(keys));
      return prepareTicketsQbdcodeHandoff(deps.handoff.home, tickets);
    },
    sendTicketsToQbdcode: async (keys, path, text) => {
      const tickets = assertTicketKeys(keys);
      const sent = await sendToQbdcode(deps.handoff, path, text);
      const sends = recordTicketSends(deps, tickets, sent);
      const started = await deps.startTickets(tickets);
      for (const problem of started.problems) {
        console.warn(`Couldn't move a ticket handed to QbDCode to In Testing / Development: ${problem}`);
      }
      return sends;
    },
  };
}

/**
 * Where tickets were sent, as saved.
 * @param settings The settings table.
 * @returns The sends by ticket; empty when none are saved or the saved value is unreadable.
 */
export function readTicketSends(settings: Pick<Store, "getSetting">): TicketSends {
  const saved = settings.getSetting(TICKET_SENDS_KEY);
  try {
    const value = saved ? (JSON.parse(saved) as unknown) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    const sends: TicketSends = {};
    for (const [key, list] of Object.entries(value)) {
      if (Array.isArray(list)) {
        sends[key] = list.filter(isSent);
      }
    }
    return sends;
  } catch {
    return {};
  }
}

/**
 * Which qbdvision worktrees are on a branch naming each ticket, read from the branch names as they are now. A
 * branch naming two tickets ("ryan-QI-1-and-QI-2") counts for both.
 * @param home Your home folder.
 * @returns The worktrees by ticket key, the main checkout first.
 */
export function ticketWorktrees(home: string): TicketWorktrees {
  const byTicket: TicketWorktrees = {};
  for (const worktree of listWorktrees(join(home, QBDVISION_REPO))) {
    const keys = new Set(worktree.branch.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? []);
    for (const key of keys) {
      byTicket[key] = [...(byTicket[key] ?? []), { name: basename(worktree.path), path: worktree.path, branch: worktree.branch }];
    }
  }
  return byTicket;
}

/**
 * Whether a saved entry is a whole send, so one damaged entry can't break the list.
 * @param value The entry.
 * @returns True when it has an action, a label, a link or null, and a time.
 */
function isSent(value: unknown): value is TodoSent {
  const sent = value as Partial<TodoSent> | null;
  return (
    typeof sent?.action === "string" &&
    typeof sent.label === "string" &&
    (sent.url === null || typeof sent.url === "string") &&
    typeof sent.at === "number"
  );
}

/**
 * What the new conversation starts with: each ticket's number, summary, type, status, link and description.
 * @param tickets The tickets.
 * @returns The text.
 */
export function ticketsHandoffText(tickets: readonly TicketBrief[]): string {
  const opening =
    tickets.length === 1
      ? "Here's a Jira ticket from my current sprint. Please help me get it done."
      : `Here are ${tickets.length} Jira tickets from my current sprint. Please help me get them done.`;
  const parts = [opening];
  for (const ticket of tickets) {
    parts.push("", `## ${ticket.key}: ${ticket.summary}`, [ticket.type, ticket.status, ticket.url].filter(Boolean).join(" · "));
    if (ticket.description) {
      const description = ticket.description.length > MAX_DESCRIPTION_CHARS ? `${cutText(ticket.description, MAX_DESCRIPTION_CHARS)}…` : ticket.description;
      parts.push("", description);
    }
  }
  return parts.join("\n");
}

/**
 * Remembers a send against each ticket in it. Only the latest few per ticket, and the most recently sent tickets,
 * are kept, so the record stays small.
 * @param deps The settings table and the clock.
 * @param keys The tickets sent.
 * @param sent Where they went.
 * @returns The sends by ticket, this one included.
 */
export function recordTicketSends(deps: Pick<TicketHandoffDependencies, "settings" | "now">, keys: readonly string[], sent: Omit<TodoSent, "at">): TicketSends {
  const sends = readTicketSends(deps.settings);
  const at = deps.now();
  for (const key of keys) {
    sends[key] = [...(sends[key] ?? []), { ...sent, at }].slice(-MAX_SENDS_PER_TICKET);
  }
  const latest = (key: string) => sends[key].at(-1)?.at ?? 0;
  const kept = Object.keys(sends)
    .sort((a, b) => latest(b) - latest(a))
    .slice(0, MAX_TICKETS_REMEMBERED);
  const trimmed: TicketSends = Object.fromEntries(kept.map((key) => [key, sends[key]]));
  deps.settings.setSetting(TICKET_SENDS_KEY, JSON.stringify(trimmed));
  return trimmed;
}

/**
 * What the QbDCode popup starts with for tickets. The worktree already on one of the tickets' branches is picked
 * to start with, so carrying on a ticket lands where its work is.
 * @param home Your home folder.
 * @param tickets The tickets.
 * @returns The instructions, the worktrees, and the one to start on.
 */
export function prepareTicketsQbdcodeHandoff(home: string, tickets: readonly TicketBrief[]): QbdcodeHandoff {
  const worktrees = listWorktrees(join(home, QBDVISION_REPO));
  const keys = new Set(tickets.map((ticket) => ticket.key));
  const onTicket = worktrees.find((worktree) => keys.has(shortBranch(worktree.branch)));
  return {
    text: withPlanFirst(ticketsHandoffText(tickets)),
    worktrees: worktrees.map((worktree) => ({ path: worktree.path, label: `${basename(worktree.path)} (${shortBranch(worktree.branch)})` })),
    preferredPath: onTicket?.path ?? null,
  };
}
