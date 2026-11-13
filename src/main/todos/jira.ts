import {
  type JiraDraft,
  type JiraSettings,
  type JiraSettingsInput,
  type JiraSprint,
  type JiraUser,
  MAX_JIRA_DESCRIPTION_CHARS,
  MAX_JIRA_SUMMARY_CHARS,
  type SprintTicket,
  type SprintTicketsReport,
  type Todo,
  type TodoSent,
} from "../../shared/ipc";
import { withRequiredSections } from "../../shared/jiraSections";
import { sprintTeam } from "../../shared/jiraSprints";
import type { SecretStore } from "../store/SecretStore";
import type { Store } from "../store/Store";
import { type AdfNode, markdownToAdf } from "./markdownToAdf";
import type { TodoAction } from "./todoIpc";

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

/** The Jira field that says which engineering team a ticket belongs to, found by this name. */
export const TEAM_FIELD_NAME = "Engineering Team";

/** The kind of field Jira Software's Sprint is, found by this rather than its name or id. */
const SPRINT_FIELD_TYPE = "com.pyxis.greenhopper.jira:gh-sprint";

/** The most of your sprint tickets the TODO tab lists; one page of Jira's search. */
const MAX_SPRINT_TICKETS = 100;

/** The most pages of boards or sprints read; at 50 a page, far more than a project has. */
const MAX_AGILE_PAGES = 10;

/**
 * The menu entry Jira adds to a TODO: "Make a Jira ticket…", which opens the popup where the ticket is drafted,
 * changed and made, so it never runs straight from the menu.
 * @param deps The saved settings.
 * @returns The action.
 */
export function jiraActions(deps: Pick<JiraDependencies, "settings" | "secrets">): TodoAction[] {
  return [
    {
      id: "jira",
      label: "Make a Jira ticket…",
      dialog: "jira",
      unavailable: () => jiraUnavailable(deps),
      run: () => Promise.reject(new Error("Jira tickets are made from the popup.")),
    },
  ];
}

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
 * Makes the Jira ticket set out in the popup. A story or bug gets any section it needs that was deleted by hand,
 * and the description gets a line naming the call the item came from.
 * @param deps The saved settings and fetch.
 * @param todo The item.
 * @param value The ticket as the window sent it.
 * @returns Where it went, e.g. QI-1234 and its address.
 */
export async function createJiraTicket(deps: JiraDependencies, todo: Todo, value: unknown): Promise<Omit<TodoSent, "at">> {
  const config = savedConfig(deps);
  const draft = assertJiraDraft(value, readJiraSettings(deps).issueTypes);
  const fields: Record<string, unknown> = {
    project: { key: config.projectKey },
    issuetype: { name: draft.issueType },
    summary: draft.summary,
    description: describe(todo, withRequiredSections(draft.description, draft.issueType)),
    ...(draft.assignee ? { assignee: { accountId: draft.assignee.accountId } } : {}),
  };
  const meta = draft.team === null && draft.sprint === null ? null : (await ticketFields(deps, [draft.issueType])).get(draft.issueType);
  if (draft.team !== null) {
    const team = meta?.team;
    if (!team || !team.choices.includes(draft.team)) {
      throw new Error(`${config.projectKey} ${draft.issueType}s have no "${draft.team}" Engineering Team.`);
    }
    // QI's Engineering Team is a single-choice field (schema "option"), which takes one { value }.
    fields[team.id] = { value: draft.team };
  }
  if (draft.sprint !== null) {
    if (!meta?.sprint) {
      throw new Error(`${config.projectKey} ${draft.issueType}s can't be put in a sprint. Pick Backlog.`);
    }
    await assertOpenSprint(deps, draft.sprint);
    // Jira's Sprint field takes the sprint's id as a bare number.
    fields[meta.sprint] = draft.sprint;
  }
  const created = (await jiraRequest(deps.fetch, config, "POST", "/rest/api/3/issue", { fields })) as { key?: string };
  if (!created.key || !/^[A-Z][A-Z0-9_]*-\d+$/.test(created.key)) {
    throw new Error("Jira may have made the ticket but didn't say which. Check Jira before trying again.");
  }
  return { action: "jira", label: created.key, url: `${config.site}/browse/${created.key}` };
}

/**
 * Checks with Jira that a sprint is still open and plans this project's tickets, so a ticket can't be put in a
 * closed sprint or another project's.
 * @param deps The saved settings and fetch.
 * @param id The sprint's id.
 */
async function assertOpenSprint(deps: JiraDependencies, id: number): Promise<void> {
  const config = savedConfig(deps);
  const refused = new Error("That sprint has closed or isn't one of this project's. Pick another.");
  const sprint = (await jiraRequest(deps.fetch, config, "GET", `/rest/agile/1.0/sprint/${id}`).catch(() => {
    throw refused;
  })) as { state?: string; originBoardId?: number };
  if (sprint.state !== "active" && sprint.state !== "future") {
    throw refused;
  }
  const board = (await jiraRequest(deps.fetch, config, "GET", `/rest/agile/1.0/board/${sprint.originBoardId}/project?maxResults=50`).catch(
    () => null,
  )) as { values?: { key?: string }[] } | null;
  // A board Jira won't describe (e.g. one in another space) is let through; Jira itself refuses a wrong sprint.
  if (board && !(board.values ?? []).some((project) => project.key === config.projectKey)) {
    throw refused;
  }
}

/**
 * Checks a ticket sent by the window: a saved type, a one-line summary, a description and an assignee of the
 * right sizes. The team is checked against Jira when the ticket is made.
 * @param value What it sent.
 * @param issueTypes The ticket types saved in Settings.
 * @returns The ticket, its summary and description trimmed.
 */
export function assertJiraDraft(value: unknown, issueTypes: readonly string[]): JiraDraft {
  const draft = value as Partial<JiraDraft> | null;
  if (typeof draft !== "object" || draft === null) {
    throw new Error("Not a Jira ticket.");
  }
  if (typeof draft.issueType !== "string" || !issueTypes.includes(draft.issueType)) {
    throw new Error(`Pick a type of ticket: ${issueTypes.join(", ")}.`);
  }
  const summary = typeof draft.summary === "string" ? draft.summary.replace(/\s+/g, " ").trim() : "";
  if (!summary || summary.length > MAX_JIRA_SUMMARY_CHARS) {
    throw new Error(`Give the ticket a summary of up to ${MAX_JIRA_SUMMARY_CHARS} characters.`);
  }
  if (typeof draft.description !== "string" || draft.description.length > MAX_JIRA_DESCRIPTION_CHARS) {
    throw new Error(`Keep the description to ${MAX_JIRA_DESCRIPTION_CHARS.toLocaleString()} characters.`);
  }
  const assignee = draft.assignee ?? null;
  if (
    assignee !== null &&
    (typeof assignee.accountId !== "string" || !/^[\w:-]{1,128}$/.test(assignee.accountId) || typeof assignee.displayName !== "string")
  ) {
    throw new Error("Pick someone to assign it to from the list.");
  }
  const team = draft.team ?? null;
  if (team !== null && (typeof team !== "string" || team.length > 100)) {
    throw new Error("Pick an Engineering Team from the list.");
  }
  const sprint = draft.sprint ?? null;
  if (sprint !== null && !(Number.isSafeInteger(sprint) && sprint > 0)) {
    throw new Error("Pick a sprint from the list.");
  }
  return {
    issueType: draft.issueType,
    summary,
    description: draft.description.trim(),
    assignee: assignee && { accountId: assignee.accountId, displayName: assignee.displayName },
    team,
    sprint,
  };
}

/**
 * The ticket's description: the text written for it, then a line naming the call the item came from.
 * @param todo The item.
 * @param markdown The description as written, in Markdown.
 * @returns The document.
 */
export function describe(todo: Todo, markdown: string): AdfNode {
  const doc = markdownToAdf(markdown);
  if (todo.source) {
    const when = new Date(todo.source.saidAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    doc.content = [
      ...(doc.content ?? []),
      { type: "paragraph", content: [{ type: "text", text: `From the call "${todo.source.title}", ${when}.`, marks: [{ type: "em" }] }] },
    ];
  }
  return doc;
}

/**
 * The project's Engineering Team and Sprint fields for each of some types of ticket: the team field's id and
 * choices, and the sprint field's id.
 * @param deps The saved settings and fetch.
 * @param issueTypes The types of ticket.
 * @returns Each type's fields, null for one it lacks; a type the project doesn't have gets neither.
 */
export async function ticketFields(
  deps: JiraDependencies,
  issueTypes: readonly string[],
): Promise<Map<string, { team: { id: string; choices: string[] } | null; sprint: string | null }>> {
  const config = savedConfig(deps);
  const project = encodeURIComponent(config.projectKey);
  const types = (await jiraRequest(deps.fetch, config, "GET", `/rest/api/3/issue/createmeta/${project}/issuetypes`)) as {
    issueTypes?: { id: string; name: string }[];
  };
  const found = await Promise.all(
    issueTypes.map(async (issueType) => {
      const type = (types.issueTypes ?? []).find((candidate) => candidate.name === issueType);
      if (!type) {
        return [issueType, { team: null, sprint: null }] as const;
      }
      const meta = (await jiraRequest(deps.fetch, config, "GET", `/rest/api/3/issue/createmeta/${project}/issuetypes/${encodeURIComponent(type.id)}?maxResults=200`)) as {
        fields?: { fieldId: string; name: string; schema?: { custom?: string }; allowedValues?: { value?: string; disabled?: boolean }[] }[];
      };
      const field = (meta.fields ?? []).find((candidate) => candidate.name === TEAM_FIELD_NAME);
      const sprint = (meta.fields ?? []).find((candidate) => candidate.schema?.custom === SPRINT_FIELD_TYPE)?.fieldId ?? null;
      if (!field) {
        return [issueType, { team: null, sprint }] as const;
      }
      const choices = (field.allowedValues ?? [])
        .filter((choice) => !choice.disabled && typeof choice.value === "string")
        .map((choice) => choice.value as string);
      return [issueType, { team: { id: field.fieldId, choices }, sprint }] as const;
    }),
  );
  return new Map<string, { team: { id: string; choices: string[] } | null; sprint: string | null }>(found);
}

/**
 * The project's sprints that are going now or still to come, from every scrum board that shows its tickets.
 * Each team plans on its own board, so the boards are read in parallel and a sprint shown on several is kept once.
 * @param deps The saved settings and fetch.
 * @param teams The Engineering Teams, to say whose each sprint is.
 * @returns The sprints, earliest start first; ones without dates last.
 */
export async function listSprints(deps: JiraDependencies, teams: readonly string[]): Promise<JiraSprint[]> {
  const config = savedConfig(deps);
  const boards = await pagesOf<{ id: number }>(
    deps,
    `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(config.projectKey)}&type=scrum`,
  );
  const perBoard = await Promise.all(
    boards.map((board) =>
      pagesOf<{ id: number; name?: string; state?: string; startDate?: string; endDate?: string }>(
        deps,
        `/rest/agile/1.0/board/${encodeURIComponent(String(board.id))}/sprint?state=active,future`,
      ),
    ),
  );
  const byId = new Map<number, JiraSprint>();
  for (const sprint of perBoard.flat()) {
    if (!Number.isSafeInteger(sprint.id) || byId.has(sprint.id) || (sprint.state !== "active" && sprint.state !== "future")) {
      continue;
    }
    const name = typeof sprint.name === "string" ? sprint.name : `Sprint ${sprint.id}`;
    byId.set(sprint.id, {
      id: sprint.id,
      name,
      state: sprint.state,
      start: readDate(sprint.startDate),
      end: readDate(sprint.endDate),
      team: sprintTeam(name, teams),
    });
  }
  return [...byId.values()].sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.id - b.id);
}

/**
 * Reads every page of one of Jira's agile lists ({ values, isLast }).
 * @param deps The saved settings and fetch.
 * @param path The list's address, with its query.
 * @returns All the entries.
 */
async function pagesOf<T>(deps: JiraDependencies, path: string): Promise<T[]> {
  const config = savedConfig(deps);
  const all: T[] = [];
  for (let page = 0; page < MAX_AGILE_PAGES; page += 1) {
    const reply = (await jiraRequest(deps.fetch, config, "GET", `${path}&maxResults=50&startAt=${all.length}`)) as { values?: T[]; isLast?: boolean };
    const values = reply.values ?? [];
    all.push(...values);
    if (reply.isLast !== false || values.length === 0) {
      break;
    }
  }
  return all;
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
      jql: "assignee = currentUser() AND sprint in openSprints() ORDER BY Rank ASC",
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
 * The people in the project a ticket can be assigned to whose name or email matches.
 * @param deps The saved settings and fetch.
 * @param query What was typed, e.g. "Adr".
 * @returns Up to ten of them.
 */
export async function searchAssignees(deps: JiraDependencies, query: unknown): Promise<JiraUser[]> {
  if (typeof query !== "string" || query.trim() === "" || query.length > 100) {
    return [];
  }
  const config = savedConfig(deps);
  const params = new URLSearchParams({ project: config.projectKey, query: query.trim(), maxResults: "10" });
  const users = (await jiraRequest(deps.fetch, config, "GET", `/rest/api/3/user/assignable/search?${params}`)) as unknown;
  return Array.isArray(users) ? users.flatMap(readUser) : [];
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
