import type { JiraSettings, JiraSettingsInput, Todo, TodoSent } from "../../shared/ipc";
import type { SecretStore } from "../store/SecretStore";
import type { Store } from "../store/Store";
import { type AdfNode, markdownToAdf, summaryOf } from "./markdownToAdf";
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
interface JiraConfig {
  site: string;
  email: string;
  projectKey: string;
  token: string;
}

/**
 * The menu entries Jira adds to a TODO: "Make a Jira Task", "Make a Jira Bug"… one per saved ticket type.
 * @param deps The saved settings and fetch.
 * @returns The actions, in the order the types were saved.
 */
export function jiraActions(deps: JiraDependencies): TodoAction[] {
  return readJiraSettings(deps).issueTypes.map((issueType) => ({
    id: `jira:${issueType}`,
    label: `Make a Jira ${issueType}`,
    unavailable: () => jiraUnavailable(deps),
    run: (todo: Todo) => createJiraTicket(deps, todo, issueType),
  }));
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
 * Makes a Jira ticket from an item, assigned to you: its first line is the summary, the whole item (with its
 * formatting and links) the description, plus the call it came from.
 * @param deps The saved settings and fetch.
 * @param todo The item.
 * @param issueType The type of ticket, e.g. "Story (FRS)".
 * @returns Where it went, e.g. QI-1234 and its address.
 */
export async function createJiraTicket(deps: JiraDependencies, todo: Todo, issueType: string): Promise<Omit<TodoSent, "at">> {
  const config = savedConfig(deps);
  const me = (await jiraRequest(deps.fetch, config, "GET", "/rest/api/3/myself")) as { accountId?: string };
  const created = (await jiraRequest(deps.fetch, config, "POST", "/rest/api/3/issue", {
    fields: {
      project: { key: config.projectKey },
      issuetype: { name: issueType },
      summary: summaryOf(todo.markdown),
      description: describe(todo),
      ...(me.accountId ? { assignee: { accountId: me.accountId } } : {}),
    },
  })) as { key?: string };
  if (!created.key || !/^[A-Z][A-Z0-9_]*-\d+$/.test(created.key)) {
    throw new Error("Jira didn't say which ticket it made.");
  }
  return { action: "jira", label: created.key, url: `${config.site}/browse/${created.key}` };
}

/**
 * The ticket's description: the item, then a line naming the call it came from.
 * @param todo The item.
 * @returns The document.
 */
export function describe(todo: Todo): AdfNode {
  const doc = markdownToAdf(todo.markdown);
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
function savedConfig(deps: Pick<JiraDependencies, "settings" | "secrets">): JiraConfig {
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
