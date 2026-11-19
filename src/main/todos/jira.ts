import {
  type JiraSettings,
  type JiraSettingsInput,
  MAX_HANDOFF_TICKETS,
  type SprintTicket,
  type SprintTicketsReport,
  type TicketBrief,
  type TicketMove,
} from "../../shared/ipc";
import type { SecretStore } from "../store/SecretStore";
import type { Store } from "../store/Store";
import { adfToText } from "./adfToText";

/** A Jira account: who you are signed in as. */
export interface JiraUser {
  accountId: string;
  displayName: string;
}

/** Where the Jira settings live: the settings table, and the token in the secret store. */
export const JIRA_KEYS = {
  site: "jira.site",
  email: "jira.email",
  projectKey: "jira.projectKey",
  /** The ticket types the menu offers, as a JSON list. */
  issueTypes: "jira.issueTypes",
  /** The one type saved before there was a list; still offered until the list is saved. */
  issueType: "jira.issueType",
  token: "jira.apiToken",
} as const;

/** Settings shown before any are saved: QbDVision's Jira, the engineering project, its everyday ticket types. */
export const JIRA_DEFAULTS = {
  site: "https://cherrycircle.atlassian.net",
  projectKey: "QI",
  issueTypes: ["Task", "Story (FRS)", "Epic (URS)", "Bug"],
};

/** The most ticket types the menu offers. */
const MAX_ISSUE_TYPES = 10;

/** What the Jira code reads and writes. */
export interface JiraDependencies {
  settings: Pick<Store, "getSetting" | "setSetting">;
  secrets: Pick<SecretStore, "get" | "set">;
  fetch: typeof fetch;
}

/** Everything needed to call Jira. */
export interface JiraConfig {
  site: string;
  email: string;
  projectKey: string;
  token: string;
}


/** The kind of field Jira Software's Sprint is, found by this rather than its name or id. */
const SPRINT_FIELD_TYPE = "com.pyxis.greenhopper.jira:gh-sprint";

/** The most of your sprint tickets the TODO tab lists; one page of Jira's search. */
const MAX_SPRINT_TICKETS = 100;

/** Statuses whose tickets are left off the TODO tab's list: the work is merged or released, nothing left for you. */
export const HIDDEN_STATUSES = ["Merged to Master", "Released to Standard", "Released to Validated"];

/** A Jira ticket key, e.g. "QI-16807". */
const TICKET_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;


/**
 * The Jira settings as Settings shows them; the token itself never leaves the main process.
 * @param deps Where they're kept.
 * @returns The settings.
 */
export function readJiraSettings(deps: Pick<JiraDependencies, "settings" | "secrets">): JiraSettings {
  return {
    site: deps.settings.getSetting(JIRA_KEYS.site) ?? JIRA_DEFAULTS.site,
    email: deps.settings.getSetting(JIRA_KEYS.email) ?? "",
    projectKey: deps.settings.getSetting(JIRA_KEYS.projectKey) ?? JIRA_DEFAULTS.projectKey,
    issueTypes: savedIssueTypes(deps.settings),
    hasToken: deps.secrets.get(JIRA_KEYS.token) !== null,
  };
}

/**
 * The saved ticket types: the list once saved, else the one type saved before there was a list, else the defaults.
 * The defaults are the default project's types (checked against QI), so they're only added to a type saved before
 * for that same project, never to one someone checked against their own.
 * @param settings Where they're kept.
 * @returns The types.
 */
function savedIssueTypes(settings: JiraDependencies["settings"]): string[] {
  const list = settings.getSetting(JIRA_KEYS.issueTypes);
  if (list !== null) {
    try {
      const parsed = JSON.parse(list) as unknown;
      if (isTypeList(parsed)) {
        return parsed;
      }
    } catch {
      // A damaged list falls back below.
    }
  }
  const before = settings.getSetting(JIRA_KEYS.issueType);
  if (before === null) {
    return JIRA_DEFAULTS.issueTypes;
  }
  const site = settings.getSetting(JIRA_KEYS.site) ?? JIRA_DEFAULTS.site;
  const projectKey = settings.getSetting(JIRA_KEYS.projectKey) ?? JIRA_DEFAULTS.projectKey;
  if (site === JIRA_DEFAULTS.site && projectKey === JIRA_DEFAULTS.projectKey) {
    return [before, ...JIRA_DEFAULTS.issueTypes.filter((type) => type !== before)];
  }
  return [before];
}

/**
 * Whether a saved list follows the rules a list must pass to be saved.
 * @param value The parsed list.
 * @returns True when it's 1 to 10 distinct, trimmed, non-empty names of at most 100 characters.
 */
function isTypeList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_ISSUE_TYPES &&
    new Set(value).size === value.length &&
    value.every((type) => typeof type === "string" && type !== "" && type === type.trim() && type.length <= 100)
  );
}

/**
 * Why a Jira ticket can't be made yet.
 * @param deps Where the settings are kept.
 * @returns The reason, or null when Jira is set up.
 */
export function jiraUnavailable(deps: Pick<JiraDependencies, "settings" | "secrets">): string | null {
  const settings = readJiraSettings(deps);
  if (!settings.email || !settings.hasToken) {
    return "Set up Jira in Settings first.";
  }
  return null;
}

/**
 * Checks new Jira settings against Jira (your account, then the project and its ticket type) and saves them.
 * @param deps Where they're kept, and fetch.
 * @param value What the window sent.
 * @returns The saved settings.
 */
export async function saveJiraSettings(deps: JiraDependencies, value: unknown): Promise<JiraSettings> {
  const input = assertJiraSettingsInput(value);
  const saved = readJiraSettings(deps);
  // The saved token only ever goes back to the site and account it was saved for.
  if (input.token === null && saved.hasToken && (input.site !== saved.site || input.email !== saved.email)) {
    throw new Error("Paste the API token again for the new site or email.");
  }
  const token = input.token ?? deps.secrets.get(JIRA_KEYS.token);
  if (!token) {
    throw new Error("Paste a Jira API token (id.atlassian.com → Security → API tokens).");
  }
  const config: JiraConfig = { site: input.site, email: input.email, projectKey: input.projectKey, token };
  await jiraRequest(deps.fetch, config, "GET", "/rest/api/3/myself");
  const types = (await jiraRequest(deps.fetch, config, "GET", `/rest/api/3/issue/createmeta/${encodeURIComponent(config.projectKey)}/issuetypes`)) as {
    issueTypes?: { name: string }[];
  };
  const names = (types.issueTypes ?? []).map((type) => type.name);
  const missing = input.issueTypes.filter((type) => !names.includes(type));
  if (missing.length > 0) {
    throw new Error(`${config.projectKey} has no ${missing.map((type) => `"${type}"`).join(" or ")} type. It has: ${names.join(", ")}.`);
  }
  deps.settings.setSetting(JIRA_KEYS.site, config.site);
  deps.settings.setSetting(JIRA_KEYS.email, config.email);
  deps.settings.setSetting(JIRA_KEYS.projectKey, config.projectKey);
  deps.settings.setSetting(JIRA_KEYS.issueTypes, JSON.stringify(input.issueTypes));
  if (input.token !== null) {
    deps.secrets.set(JIRA_KEYS.token, input.token);
  }
  return readJiraSettings(deps);
}

/**
 * A date from Jira as a time.
 * @param value The date, e.g. "2026-11-24T15:00:00.000Z".
 * @returns The time, or null when missing or unreadable.
 */
function readDate(value: unknown): number | null {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? null : time;
}

/**
 * The tickets assigned to you in any sprint going now, in the board's order with finished ones last, for the TODO
 * tab. Never throws: Jira not set up or unreachable comes back as the report's problem.
 * @param deps The saved settings and fetch.
 * @returns The tickets, the sprints they're in, or why they couldn't be read.
 */
export async function listMySprintTickets(deps: JiraDependencies): Promise<SprintTicketsReport> {
  const unavailable = jiraUnavailable(deps);
  if (unavailable) {
    return { tickets: [], sprints: [], problem: unavailable };
  }
  try {
    const config = savedConfig(deps);
    const fields = (await jiraRequest(deps.fetch, config, "GET", "/rest/api/3/field")) as { id?: unknown; schema?: { custom?: unknown } }[];
    const sprintField = Array.isArray(fields) ? fields.find((field) => field.schema?.custom === SPRINT_FIELD_TYPE)?.id : undefined;
    const params = new URLSearchParams({
      jql: `assignee = currentUser() AND sprint in openSprints() AND status NOT IN (${HIDDEN_STATUSES.map((name) => `"${name}"`).join(", ")}) ORDER BY Rank ASC`,
      fields: ["summary", "status", "issuetype", ...(typeof sprintField === "string" ? [sprintField] : [])].join(","),
      maxResults: String(MAX_SPRINT_TICKETS),
    });
    const reply = (await jiraRequest(deps.fetch, config, "GET", `/rest/api/3/search/jql?${params}`)) as { issues?: unknown[] };
    const issues = (reply.issues ?? []).map((issue) => readSprintIssue(issue, config.site, typeof sprintField === "string" ? sprintField : null));
    const tickets = issues.flatMap((issue) => (issue ? [issue.ticket] : []));
    const sprints = [...new Set(issues.flatMap((issue) => issue?.activeSprints ?? []))];
    // Stable, so each group keeps the board's order.
    tickets.sort((a, b) => Number(a.statusCategory === "done") - Number(b.statusCategory === "done"));
    return { tickets, sprints, problem: null };
  } catch (error) {
    return { tickets: [], sprints: [], problem: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The states a ticket can be moved to from where it is now, as Jira's workflow allows. Each state is offered once
 * (two moves can lead to the same one), and the ticket's own state isn't.
 * @param deps The saved settings and fetch.
 * @param key The ticket, e.g. "QI-16807".
 * @returns The moves, in Jira's order.
 */
export async function listTicketMoves(deps: JiraDependencies, key: unknown): Promise<TicketMove[]> {
  const ticket = assertTicketKey(key);
  const reply = (await jiraRequest(deps.fetch, savedConfig(deps), "GET", `/rest/api/3/issue/${ticket}/transitions`)) as { transitions?: unknown[] };
  const moves: TicketMove[] = [];
  for (const raw of reply.transitions ?? []) {
    const transition = raw as { id?: unknown; to?: { name?: unknown; statusCategory?: { key?: unknown } } } | null;
    const status = transition?.to?.name;
    const category = transition?.to?.statusCategory?.key;
    if (typeof transition?.id !== "string" || typeof status !== "string" || moves.some((move) => move.status === status)) {
      continue;
    }
    moves.push({ id: transition.id, status, statusCategory: category === "done" || category === "indeterminate" ? category : "new" });
  }
  return moves;
}

/**
 * Moves a ticket to another state, then reads your sprint list again so the tab shows it where it is now (or not
 * at all, once it's merged or released).
 * @param deps The saved settings and fetch.
 * @param key The ticket.
 * @param moveId The move, one of those listTicketMoves offered.
 * @returns The list after the move.
 */
export async function moveTicket(deps: JiraDependencies, key: unknown, moveId: unknown): Promise<SprintTicketsReport> {
  const ticket = assertTicketKey(key);
  if (typeof moveId !== "string" || !/^\d+$/.test(moveId)) {
    throw new Error("Not a state this ticket can move to.");
  }
  await jiraRequest(deps.fetch, savedConfig(deps), "POST", `/rest/api/3/issue/${ticket}/transitions`, { transition: { id: moveId } });
  return listMySprintTickets(deps);
}

/** The state a ticket goes to once it's handed to QbDCode to work on. */
export const STARTED_STATUS = "In Testing / Development";

/**
 * QI's states before work starts, which a ticket handed to QbDCode leaves. Listed by name rather than by Jira's "to
 * do" group, since that group also holds later states ("QA Signed Off", "Fix has been submitted").
 */
export const NOT_STARTED_STATUSES = [
  "Backlog",
  "New",
  "Open",
  "In Draft",
  "Prioritized",
  "Product / Design review",
  "Detailed Design",
  "Product signed off",
];

/**
 * Moves each ticket that hasn't been started yet (Backlog, In Draft, a design state…) to In Testing / Development,
 * for when it has just been handed to QbDCode. A ticket already further on, or whose workflow has no such move, is
 * left where it is. Never throws, so a Jira hiccup can't undo a hand-off that already happened.
 * @param deps The saved settings and fetch.
 * @param keys The tickets handed over.
 * @returns The tickets moved, and a line for each one that couldn't be.
 */
export async function startTickets(deps: JiraDependencies, keys: readonly string[]): Promise<{ moved: string[]; problems: string[] }> {
  const moved: string[] = [];
  const problems: string[] = [];
  if (jiraUnavailable(deps)) {
    return { moved, problems };
  }
  const notStarted = new Set(NOT_STARTED_STATUSES.map((name) => name.toLowerCase()));
  for (const key of keys) {
    try {
      const issue = (await jiraRequest(deps.fetch, savedConfig(deps), "GET", `/rest/api/3/issue/${assertTicketKey(key)}?fields=status`)) as {
        fields?: { status?: { name?: unknown } };
      };
      const status = issue.fields?.status?.name;
      if (typeof status !== "string" || !notStarted.has(status.toLowerCase())) {
        continue;
      }
      const move = (await listTicketMoves(deps, key)).find((item) => item.status.toLowerCase() === STARTED_STATUS.toLowerCase());
      if (!move) {
        problems.push(`${key}: no move from ${status} to ${STARTED_STATUS}`);
        continue;
      }
      await jiraRequest(deps.fetch, savedConfig(deps), "POST", `/rest/api/3/issue/${key}/transitions`, { transition: { id: move.id } });
      moved.push(key);
    } catch (error) {
      problems.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { moved, problems };
}

/** A ticket of yours that moved in a stretch of time, for questions about your work. */
export interface TicketActivity {
  key: string;
  summary: string;
  type: string;
  /** Where it is now. */
  status: string;
  /** When you created it, if you did within the stretch. */
  createdByYouAt: number | null;
  /** Its status changes within the stretch, earliest first. */
  moves: { at: number; from: string; to: string; by: string }[];
}

/** The tickets of yours that moved in a stretch of time, or why they couldn't be read. */
export interface TicketActivityReport {
  tickets: TicketActivity[];
  problem: string | null;
}

/** The most tickets read for one stretch. */
const MAX_ACTIVITY_TICKETS = 100;

/**
 * The tickets you were assigned (now or earlier) whose status changed in a stretch of time, and the ones you created
 * in it, each with its status changes then and who made them. Never throws: Jira not set up or unreachable comes
 * back as the report's problem.
 * @param deps The saved settings and fetch.
 * @param from The stretch's start, in milliseconds.
 * @param to Its end.
 * @returns The tickets, most recently changed first.
 */
export async function listMyTicketActivity(deps: JiraDependencies, from: number, to: number): Promise<TicketActivityReport> {
  const unavailable = jiraUnavailable(deps);
  if (unavailable) {
    return { tickets: [], problem: unavailable };
  }
  try {
    const config = savedConfig(deps);
    const start = jqlTime(from);
    const end = jqlTime(to);
    const params = new URLSearchParams({
      jql:
        `((assignee = currentUser() OR assignee WAS currentUser()) AND status CHANGED DURING ("${start}", "${end}")) ` +
        `OR (reporter = currentUser() AND created >= "${start}" AND created < "${end}") ORDER BY updated DESC`,
      fields: "summary,status,issuetype,created,reporter",
      expand: "changelog",
      maxResults: String(MAX_ACTIVITY_TICKETS),
    });
    const me = await myself(deps);
    const reply = (await jiraRequest(deps.fetch, config, "GET", `/rest/api/3/search/jql?${params}`)) as { issues?: unknown[] };
    const tickets = (reply.issues ?? []).flatMap((issue) => {
      const read = readTicketActivity(issue, from, to, me?.accountId ?? null);
      return read ? [read] : [];
    });
    return { tickets, problem: null };
  } catch (error) {
    return { tickets: [], problem: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Writes a moment the way JQL takes it, in this Mac's time zone.
 * @param ms The moment.
 * @returns e.g. "2026/11/09 00:00".
 */
function jqlTime(ms: number): string {
  const date = new Date(ms);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}/${two(date.getMonth() + 1)}/${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/**
 * Reads one ticket and its status changes within a stretch from Jira's search answer (with its changelog).
 * @param value The issue as Jira sent it.
 * @param from The stretch's start.
 * @param to Its end.
 * @param myId Your Jira account id, to tell which tickets you created; null when unknown.
 * @returns The ticket, or null when it isn't readable.
 */
export function readTicketActivity(value: unknown, from: number, to: number, myId: string | null): TicketActivity | null {
  const issue = value as {
    key?: unknown;
    fields?: Record<string, unknown>;
    changelog?: { histories?: { created?: unknown; author?: { displayName?: unknown }; items?: { field?: unknown; fromString?: unknown; toString?: unknown }[] }[] };
  } | null;
  const fields = issue?.fields;
  if (!issue || typeof issue.key !== "string" || !fields) {
    return null;
  }
  const moves: TicketActivity["moves"] = [];
  for (const history of issue.changelog?.histories ?? []) {
    const at = readDate(history.created);
    if (at === null || at < from || at >= to) {
      continue;
    }
    for (const item of history.items ?? []) {
      if (item.field === "status") {
        const by = typeof history.author?.displayName === "string" ? history.author.displayName : "someone";
        moves.push({ at, from: String(item.fromString ?? ""), to: String(item.toString ?? ""), by });
      }
    }
  }
  moves.sort((a, b) => a.at - b.at);
  const created = readDate(fields.created);
  const reporter = (fields.reporter as { accountId?: unknown } | undefined)?.accountId;
  const mine = myId !== null && reporter === myId && created !== null && created >= from && created < to;
  return {
    key: issue.key,
    summary: typeof fields.summary === "string" ? fields.summary : issue.key,
    type: typeof (fields.issuetype as { name?: unknown } | undefined)?.name === "string" ? String((fields.issuetype as { name: string }).name) : "",
    status: typeof (fields.status as { name?: unknown } | undefined)?.name === "string" ? String((fields.status as { name: string }).name) : "",
    createdByYouAt: mine ? created : null,
    moves,
  };
}

/**
 * Reads tickets from Jira to hand to Claude: each one's summary, type, status, address and description as text.
 * @param deps The saved settings and fetch.
 * @param keys The tickets, as the window sent them.
 * @returns The tickets, in the order asked.
 */
export async function readTicketBriefs(deps: JiraDependencies, keys: unknown): Promise<TicketBrief[]> {
  const tickets = assertTicketKeys(keys);
  const config = savedConfig(deps);
  return Promise.all(
    tickets.map(async (key) => {
      const issue = (await jiraRequest(deps.fetch, config, "GET", `/rest/api/3/issue/${key}?fields=summary,issuetype,status,description`)) as {
        fields?: { summary?: unknown; issuetype?: { name?: unknown }; status?: { name?: unknown }; description?: unknown };
      };
      const fields = issue.fields ?? {};
      return {
        key,
        summary: typeof fields.summary === "string" ? fields.summary : key,
        type: typeof fields.issuetype?.name === "string" ? fields.issuetype.name : "",
        status: typeof fields.status?.name === "string" ? fields.status.name : "",
        url: `${config.site}/browse/${encodeURIComponent(key)}`,
        description: adfToText(fields.description),
      };
    }),
  );
}

/**
 * Checks a list of ticket keys sent by the window: one to MAX_HANDOFF_TICKETS of them, each once.
 * @param value What it sent.
 * @returns The keys.
 */
export function assertTicketKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_HANDOFF_TICKETS) {
    throw new Error(`Pick from 1 to ${MAX_HANDOFF_TICKETS} tickets.`);
  }
  return [...new Set(value.map(assertTicketKey))];
}

/**
 * Checks a ticket key sent by the window.
 * @param value What it sent.
 * @returns The key.
 */
function assertTicketKey(value: unknown): string {
  if (typeof value !== "string" || !TICKET_KEY.test(value)) {
    throw new Error("Not a Jira ticket.");
  }
  return value;
}

/**
 * Reads one ticket from Jira's search answer.
 * @param value The issue as Jira sent it.
 * @param site The Jira site, for the ticket's address.
 * @param sprintField The Sprint field's id, or null when Jira didn't say which it is.
 * @returns The ticket and the names of its sprints going now, or null when it isn't readable.
 */
function readSprintIssue(value: unknown, site: string, sprintField: string | null): { ticket: SprintTicket; activeSprints: string[] } | null {
  const issue = value as { key?: unknown; fields?: Record<string, unknown> } | null;
  const fields = issue?.fields;
  if (!issue || typeof issue.key !== "string" || !fields) {
    return null;
  }
  const status = fields.status as { name?: unknown; statusCategory?: { key?: unknown } } | undefined;
  const category = status?.statusCategory?.key;
  const sprints = sprintField && Array.isArray(fields[sprintField]) ? (fields[sprintField] as { name?: unknown; state?: unknown }[]) : [];
  return {
    ticket: {
      key: issue.key,
      summary: typeof fields.summary === "string" ? fields.summary : issue.key,
      type: typeof (fields.issuetype as { name?: unknown } | undefined)?.name === "string" ? String((fields.issuetype as { name: string }).name) : "",
      status: typeof status?.name === "string" ? status.name : "",
      statusCategory: category === "done" || category === "indeterminate" ? category : "new",
      url: `${site}/browse/${encodeURIComponent(issue.key)}`,
    },
    activeSprints: sprints.flatMap((sprint) => (sprint.state === "active" && typeof sprint.name === "string" ? [sprint.name] : [])),
  };
}

/**
 * You, as Jira knows you.
 * @param deps The saved settings and fetch.
 * @returns Your account, or null when Jira doesn't say.
 */
export async function myself(deps: JiraDependencies): Promise<JiraUser | null> {
  const me = await jiraRequest(deps.fetch, savedConfig(deps), "GET", "/rest/api/3/myself");
  return readUser(me)[0] ?? null;
}

/**
 * Reads one person out of Jira's answer.
 * @param value A user as Jira sent it.
 * @returns The person, or nothing when it isn't one.
 */
function readUser(value: unknown): JiraUser[] {
  const user = value as { accountId?: unknown; displayName?: unknown; active?: unknown } | null;
  if (!user || typeof user.accountId !== "string" || typeof user.displayName !== "string" || user.active === false) {
    return [];
  }
  return [{ accountId: user.accountId, displayName: user.displayName }];
}

/**
 * Checks Jira settings sent by the window.
 * @param value What it sent.
 * @returns The settings, tidied: no trailing slash on the site, the project key in capitals.
 */
export function assertJiraSettingsInput(value: unknown): JiraSettingsInput {
  const input = value as Partial<JiraSettingsInput> | null;
  if (typeof input !== "object" || input === null) {
    throw new Error("Not Jira settings.");
  }
  const site = typeof input.site === "string" ? input.site.trim().replace(/\/+$/, "") : "";
  let url: URL | null = null;
  try {
    url = new URL(site);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The Jira site is its https address, e.g. https://cherrycircle.atlassian.net.");
  }
  const email = typeof input.email === "string" ? input.email.trim() : "";
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new Error("Enter the email address you sign in to Jira with.");
  }
  const projectKey = typeof input.projectKey === "string" ? input.projectKey.trim().toUpperCase() : "";
  if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(projectKey)) {
    throw new Error("The project key is the letters before a ticket's number, e.g. QI.");
  }
  const issueTypes = Array.isArray(input.issueTypes)
    ? [...new Set(input.issueTypes.map((type: unknown) => (typeof type === "string" ? type.trim() : "")))]
    : [];
  if (issueTypes.length === 0 || issueTypes.length > MAX_ISSUE_TYPES || issueTypes.some((type) => !type || type.length > 100)) {
    throw new Error(`Enter 1 to ${MAX_ISSUE_TYPES} types of ticket, separated by commas, e.g. Task, Bug.`);
  }
  if (input.token !== null && (typeof input.token !== "string" || !input.token.trim() || input.token.length > 1_000)) {
    throw new Error("Paste a Jira API token, or leave it empty to keep the saved one.");
  }
  return { site, email, projectKey, issueTypes, token: input.token === null ? null : input.token.trim() };
}

/**
 * The saved settings with the token, for a call to Jira.
 * @param deps Where they're kept.
 * @returns The config.
 */
export function savedConfig(deps: Pick<JiraDependencies, "settings" | "secrets">): JiraConfig {
  const settings = readJiraSettings(deps);
  const token = deps.secrets.get(JIRA_KEYS.token);
  if (!settings.email || !token) {
    throw new Error("Set up Jira in Settings first.");
  }
  return { site: settings.site, email: settings.email, projectKey: settings.projectKey, token };
}

/**
 * Calls Jira's REST API with your email and token.
 * @param fetchJira fetch.
 * @param config Where and as whom.
 * @param method GET or POST.
 * @param path The API path.
 * @param body What to send, for a POST.
 * @returns Jira's JSON answer.
 */
async function jiraRequest(fetchJira: typeof fetch, config: JiraConfig, method: "GET" | "POST", path: string, body?: object): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchJira(`${config.site}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.email}:${config.token}`).toString("base64")}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error(`Couldn't reach Jira at ${config.site}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw new Error("Jira didn't accept that email and token.");
  }
  if (!response.ok) {
    throw new Error(`Jira said: ${jiraError(text) ?? `HTTP ${response.status}`}`);
  }
  return text ? JSON.parse(text) : {};
}

/**
 * Jira's own words from an error answer.
 * @param text The answer's body.
 * @returns Its messages joined, or null when there are none.
 */
function jiraError(text: string): string | null {
  try {
    const body = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> };
    const messages = [...(body.errorMessages ?? []), ...Object.entries(body.errors ?? {}).map(([field, message]) => `${field}: ${message}`)];
    return messages.length > 0 ? messages.join("; ") : null;
  } catch {
    return null;
  }
}
