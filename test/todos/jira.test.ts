import type { JiraDraft, Todo } from "../../src/shared/ipc";
import {
  JIRA_KEYS,
  assertJiraDraft,
  assertJiraSettingsInput,
  createJiraTicket,
  jiraActions,
  jiraUnavailable,
  listMySprintTickets,
  listSprints,
  readJiraSettings,
  saveJiraSettings,
} from "../../src/main/todos/jira";

const SITE = "https://example.atlassian.net";

/** Settings and secrets held in maps, standing in for the database and the Keychain. */
function fakeStores() {
  const settings = new Map<string, string>();
  const secrets = new Map<string, string>();
  return {
    settings: {
      getSetting: (key: string) => settings.get(key) ?? null,
      setSetting: (key: string, value: string | null) => {
        if (value === null) {
          settings.delete(key);
        } else {
          settings.set(key, value);
        }
      },
    },
    secrets: {
      get: (name: string) => secrets.get(name) ?? null,
      set: (name: string, value: string | null) => {
        if (value === null) {
          secrets.delete(name);
        } else {
          secrets.set(name, value);
        }
      },
    },
    rawSettings: settings,
    rawSecrets: secrets,
  };
}

/** A fetch that answers each path from a table, recording what was asked. */
function fakeFetch(answers: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchJira = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const answer = answers[`${init.method} ${path}`];
    if (!answer) {
      return new Response(JSON.stringify({ errorMessages: [`no fake for ${path}`] }), { status: 404 });
    }
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchJira, calls };
}

const INPUT = { site: `${SITE}/`, email: "me@example.com", projectKey: "qi", issueTypes: ["Task"], token: "secret-token" };

const TODO: Todo = {
  id: 1,
  markdown: "Send **Dana** the [keys](https://x.y)\n\n- by Friday",
  section: "work",
  createdAt: 0,
  doneAt: null,
  source: { recordingId: 4, title: "Weekly sync", saidAt: new Date(2026, 10, 10, 10, 2).getTime() },
  sent: [],
};

/** A ticket as the popup sends it. */
const DRAFT: JiraDraft = {
  issueType: "Task",
  summary: "Send Dana the keys",
  description: "Send **Dana** the [keys](https://x.y)\n\n- by Friday",
  assignee: { accountId: "dana-1", displayName: "Dana Scully" },
  team: "Platform",
  sprint: null,
};

/** QI's two scrum boards and their open sprints, the same sprint showing on both. */
const SPRINTS = {
  "GET /rest/agile/1.0/board": { body: { values: [{ id: 375 }, { id: 373 }], isLast: true } },
  "GET /rest/agile/1.0/board/375/sprint": {
    body: {
      values: [
        { id: 1652, name: "Platform - November", state: "active", startDate: "2026-11-02T15:00:00.000Z", endDate: "2026-12-01T15:00:00.000Z" },
        { id: 1653, name: "Platform - December", state: "future", startDate: "2026-12-01T15:00:00.000Z", endDate: "2026-12-31T15:00:00.000Z" },
      ],
      isLast: true,
    },
  },
  "GET /rest/agile/1.0/board/373/sprint": {
    body: {
      values: [
        { id: 1690, name: "PØD-2026-23", state: "future", startDate: "2026-11-24T15:00:00.000Z", endDate: "2026-12-08T15:00:00.000Z" },
        { id: 1653, name: "Platform - December", state: "future", startDate: "2026-12-01T15:00:00.000Z", endDate: "2026-12-31T15:00:00.000Z" },
        { id: 1280, name: "Performance", state: "future" },
      ],
      isLast: true,
    },
  },
};

/** QI's ticket types and the Task's Engineering Team field, as Jira describes them. */
const TEAM_META = {
  "GET /rest/api/3/issue/createmeta/QI/issuetypes": { body: { issueTypes: [{ id: "10001", name: "Task" }, { id: "10004", name: "Bug" }] } },
  "GET /rest/api/3/issue/createmeta/QI/issuetypes/10001": {
    body: {
      fields: [
        { fieldId: "summary", name: "Summary" },
        { fieldId: "customfield_10206", name: "Engineering Team", allowedValues: [{ value: "Platform" }, { value: "Bug" }, { value: "Old", disabled: true }] },
        { fieldId: "customfield_10010", name: "Sprint", schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" } },
      ],
    },
  },
};

describe("jira", () => {
  it("should show QbDVision's Jira, QI and its everyday ticket types before anything is saved, and say Jira isn't set up", () => {
    const stores = fakeStores();
    expect(readJiraSettings(stores)).toEqual({
      site: "https://cherrycircle.atlassian.net",
      email: "",
      projectKey: "QI",
      issueTypes: ["Task", "Story (FRS)", "Epic (URS)", "Bug"],
      hasToken: false,
    });
    expect(jiraUnavailable(stores)).toMatch(/Set up Jira/);
  });

  it("should put the one ticket type saved before there was a list first, adding QI's types only for QI", () => {
    const stores = fakeStores();
    stores.rawSettings.set(JIRA_KEYS.issueType, "Bug");
    expect(readJiraSettings(stores).issueTypes).toEqual(["Bug", "Task", "Story (FRS)", "Epic (URS)"]);
    stores.rawSettings.set(JIRA_KEYS.projectKey, "OPS");
    expect(readJiraSettings(stores).issueTypes).toEqual(["Bug"]);
  });

  it("should fall back when the saved list is damaged or breaks the rules", () => {
    const stores = fakeStores();
    stores.rawSettings.set(JIRA_KEYS.issueType, "Task");
    stores.rawSettings.set(JIRA_KEYS.projectKey, "OPS");
    for (const damaged of ["not json", '["Task", 3]', '[""]', '["Bug","Bug"]', JSON.stringify(Array(11).fill(0).map((_, i) => `T${i}`))]) {
      stores.rawSettings.set(JIRA_KEYS.issueTypes, damaged);
      expect(readJiraSettings(stores).issueTypes).toEqual(["Task"]);
    }
  });

  it("should offer one menu entry that opens the popup and never makes a ticket from the menu", async () => {
    const stores = fakeStores();
    stores.rawSettings.set(JIRA_KEYS.email, "me@example.com");
    stores.rawSecrets.set(JIRA_KEYS.token, "secret-token");
    stores.rawSettings.set(JIRA_KEYS.issueTypes, JSON.stringify(["Task", "Epic (URS)"]));
    const actions = jiraActions(stores);

    expect(actions.map((action) => [action.id, action.label, action.dialog, action.unavailable()])).toEqual([["jira", "Make a Jira ticket…", "jira", null]]);
    await expect(actions[0].run(TODO)).rejects.toThrow(/popup/);
  });

  it("should check the settings against Jira, then save them with the token kept as a secret", async () => {
    const stores = fakeStores();
    const { fetchJira, calls } = fakeFetch({
      "GET /rest/api/3/myself": { body: { accountId: "abc" } },
      "GET /rest/api/3/issue/createmeta/QI/issuetypes": { body: { issueTypes: [{ name: "Task" }, { name: "Bug" }] } },
    });

    const saved = await saveJiraSettings({ ...stores, fetch: fetchJira }, INPUT);

    expect(saved).toEqual({ site: SITE, email: "me@example.com", projectKey: "QI", issueTypes: ["Task"], hasToken: true });
    expect(stores.rawSecrets.get(JIRA_KEYS.token)).toBe("secret-token");
    expect([...stores.rawSettings.values()].join(" ")).not.toContain("secret-token");
    expect(calls[0].init.headers).toMatchObject({ Authorization: `Basic ${Buffer.from("me@example.com:secret-token").toString("base64")}` });
    expect(jiraUnavailable(stores)).toBeNull();
  });

  it("should save nothing when Jira refuses the token or the project has no such ticket type", async () => {
    const stores = fakeStores();
    const refused = fakeFetch({ "GET /rest/api/3/myself": { status: 401, body: {} } });
    await expect(saveJiraSettings({ ...stores, fetch: refused.fetchJira }, INPUT)).rejects.toThrow(/didn't accept/);

    const noType = fakeFetch({
      "GET /rest/api/3/myself": { body: {} },
      "GET /rest/api/3/issue/createmeta/QI/issuetypes": { body: { issueTypes: [{ name: "Bug" }] } },
    });
    await expect(saveJiraSettings({ ...stores, fetch: noType.fetchJira }, { ...INPUT, issueTypes: ["Task", "Bug", "Story (FRS)"] })).rejects.toThrow(
      'QI has no "Task" or "Story (FRS)" type. It has: Bug.',
    );

    expect(stores.rawSettings.size).toBe(0);
    expect(stores.rawSecrets.size).toBe(0);
  });

  it("should keep the saved token when none is pasted", async () => {
    const stores = fakeStores();
    stores.rawSettings.set(JIRA_KEYS.site, SITE);
    stores.rawSettings.set(JIRA_KEYS.email, "me@example.com");
    stores.rawSecrets.set(JIRA_KEYS.token, "old-token");
    const { fetchJira, calls } = fakeFetch({
      "GET /rest/api/3/myself": { body: {} },
      "GET /rest/api/3/issue/createmeta/QI/issuetypes": { body: { issueTypes: [{ name: "Task" }] } },
    });

    await saveJiraSettings({ ...stores, fetch: fetchJira }, { ...INPUT, token: null });

    expect(stores.rawSecrets.get(JIRA_KEYS.token)).toBe("old-token");
    expect(calls[0].init.headers).toMatchObject({ Authorization: `Basic ${Buffer.from("me@example.com:old-token").toString("base64")}` });
  });

  it("should never send the saved token to a new site or for a new email", async () => {
    const stores = fakeStores();
    stores.rawSettings.set(JIRA_KEYS.site, SITE);
    stores.rawSettings.set(JIRA_KEYS.email, "me@example.com");
    stores.rawSecrets.set(JIRA_KEYS.token, "old-token");
    const { fetchJira, calls } = fakeFetch({});

    await expect(saveJiraSettings({ ...stores, fetch: fetchJira }, { ...INPUT, site: "https://elsewhere.example.com", token: null })).rejects.toThrow(/Paste the API token again/);
    await expect(saveJiraSettings({ ...stores, fetch: fetchJira }, { ...INPUT, email: "someone@example.com", token: null })).rejects.toThrow(/Paste the API token again/);

    expect(calls).toHaveLength(0);
    expect(stores.rawSettings.get(JIRA_KEYS.site)).toBe(SITE);
  });

  it("should refuse a ticket key Jira sends that isn't a ticket key", async () => {
    const stores = fakeStores();
    stores.rawSettings.set(JIRA_KEYS.site, SITE);
    stores.rawSettings.set(JIRA_KEYS.email, "me@example.com");
    stores.rawSecrets.set(JIRA_KEYS.token, "secret-token");
    const { fetchJira } = fakeFetch({
      "POST /rest/api/3/issue": { body: { key: "../../evil" } },
    });

    await expect(createJiraTicket({ ...stores, fetch: fetchJira }, TODO, { ...DRAFT, team: null })).rejects.toThrow(/didn't say which\. Check Jira before trying again/);
  });

  it("should make the ticket as drafted, with its assignee, Engineering Team and the call in the description", async () => {
    const stores = fakeStores();
    stores.rawSettings.set(JIRA_KEYS.site, SITE);
    stores.rawSettings.set(JIRA_KEYS.email, "me@example.com");
    stores.rawSecrets.set(JIRA_KEYS.token, "secret-token");
    const { fetchJira, calls } = fakeFetch({
      ...TEAM_META,
      "POST /rest/api/3/issue": { status: 201, body: { key: "QI-1234" } },
    });

    const sent = await createJiraTicket({ ...stores, fetch: fetchJira }, TODO, DRAFT);

    expect(sent).toEqual({ action: "jira", label: "QI-1234", url: `${SITE}/browse/QI-1234` });
    const body = JSON.parse(String(calls.at(-1)?.init.body)) as { fields: Record<string, unknown> };
    expect(body.fields.project).toEqual({ key: "QI" });
    expect(body.fields.issuetype).toEqual({ name: "Task" });
    expect(body.fields.summary).toBe("Send Dana the keys");
    expect(body.fields.assignee).toEqual({ accountId: "dana-1" });
    expect(body.fields.customfield_10206).toEqual({ value: "Platform" });
    const description = JSON.stringify(body.fields.description);
    expect(description).toContain('"type":"bulletList"');
    expect(description).toContain('{"type":"link","attrs":{"href":"https://x.y"}}');
    expect(description).toContain("From the call \\\"Weekly sync\\\"");
  });

  it("should refuse a team Jira doesn't offer, and leave an unassigned ticket with no assignee", async () => {
    const stores = fakeStores();
    stores.rawSettings.set(JIRA_KEYS.email, "me@example.com");
    stores.rawSecrets.set(JIRA_KEYS.token, "t");
    const { fetchJira, calls } = fakeFetch({ ...TEAM_META, "POST /rest/api/3/issue": { status: 201, body: { key: "QI-9" } } });

    await expect(createJiraTicket({ ...stores, fetch: fetchJira }, TODO, { ...DRAFT, team: "Wizards" })).rejects.toThrow(/no "Wizards"/);
    expect(calls.some((call) => call.init.method === "POST")).toBe(false);
    await createJiraTicket({ ...stores, fetch: fetchJira }, TODO, { ...DRAFT, assignee: null, team: null });
    const body = JSON.parse(String(calls.at(-1)?.init.body)) as { fields: Record<string, unknown> };
    expect(body.fields).not.toHaveProperty("assignee");
    expect(body.fields).not.toHaveProperty("customfield_10206");
    expect(body.fields).not.toHaveProperty("customfield_10010");
  });

  it("should put the ticket in the sprint picked, and refuse one that isn't open in the project", async () => {
    const stores = fakeStores();
    stores.rawSettings.set(JIRA_KEYS.email, "me@example.com");
    stores.rawSecrets.set(JIRA_KEYS.token, "t");
    const { fetchJira, calls } = fakeFetch({
      ...TEAM_META,
      // Platform plans on a board shared with its own project, QP, as it does in Jira.
      "GET /rest/agile/1.0/sprint/1653": { body: { id: 1653, state: "future", originBoardId: 271 } },
      "GET /rest/agile/1.0/board/271/project": { body: { values: [{ key: "QP" }, { key: "QI" }] } },
      "GET /rest/agile/1.0/sprint/1500": { body: { id: 1500, state: "closed", originBoardId: 271 } },
      "GET /rest/agile/1.0/sprint/1600": { body: { id: 1600, state: "future", originBoardId: 9 } },
      "GET /rest/agile/1.0/board/9/project": { body: { values: [{ key: "OPS" }] } },
      "POST /rest/api/3/issue": { status: 201, body: { key: "QI-11" } },
    });

    for (const refused of [999, 1500, 1600]) {
      await expect(createJiraTicket({ ...stores, fetch: fetchJira }, TODO, { ...DRAFT, sprint: refused })).rejects.toThrow(/closed or isn't one of this project's/);
    }
    expect(calls.some((call) => call.init.method === "POST")).toBe(false);
    await createJiraTicket({ ...stores, fetch: fetchJira }, TODO, { ...DRAFT, sprint: 1653 });
    const body = JSON.parse(String(calls.at(-1)?.init.body)) as { fields: Record<string, unknown> };
    expect(body.fields.customfield_10010).toBe(1653);
  });
});

describe("listSprints", () => {
  it("should gather the open sprints from every scrum board once, earliest first, each with its team", async () => {
    const stores = fakeStores();
    stores.rawSettings.set(JIRA_KEYS.email, "me@example.com");
    stores.rawSecrets.set(JIRA_KEYS.token, "t");
    const { fetchJira, calls } = fakeFetch(SPRINTS);

    const sprints = await listSprints({ ...stores, fetch: fetchJira }, ["Platform", "PØD", "Bug"]);

    expect(sprints.map((sprint) => [sprint.id, sprint.team, sprint.state])).toEqual([
      [1652, "Platform", "active"],
      [1690, "PØD", "future"],
      [1653, "Platform", "future"],
      [1280, null, "future"],
    ]);
    expect(sprints[1].start).toBe(Date.parse("2026-11-24T15:00:00.000Z"));
    expect(new URL(calls[0].url).search).toBe("?projectKeyOrId=QI&type=scrum&maxResults=50&startAt=0");
  });

  it("should put back a bug's sections deleted by hand before making it", async () => {
    const stores = fakeStores();
    stores.rawSettings.set(JIRA_KEYS.email, "me@example.com");
    stores.rawSecrets.set(JIRA_KEYS.token, "t");
    stores.rawSettings.set(JIRA_KEYS.issueTypes, JSON.stringify(["Task", "Bug"]));
    const { fetchJira, calls } = fakeFetch({ "POST /rest/api/3/issue": { status: 201, body: { key: "QI-10" } } });

    await createJiraTicket({ ...stores, fetch: fetchJira }, TODO, { ...DRAFT, issueType: "Bug", description: "It breaks.", team: null });

    const description = JSON.stringify((JSON.parse(String(calls.at(-1)?.init.body)) as { fields: { description: unknown } }).fields.description);
    expect(description).toContain("Steps to reproduce");
    expect(description).toContain("Expected / Actual");
  });

  it("should pass on Jira's own words when it refuses a ticket", async () => {
    const stores = fakeStores();
    stores.rawSettings.set(JIRA_KEYS.email, "me@example.com");
    stores.rawSecrets.set(JIRA_KEYS.token, "t");
    const { fetchJira } = fakeFetch({
      "POST /rest/api/3/issue": { status: 400, body: { errors: { components: "Component is required." } } },
    });

    await expect(createJiraTicket({ ...stores, fetch: fetchJira }, TODO, { ...DRAFT, team: null })).rejects.toThrow("Jira said: components: Component is required.");
  });
});

describe("assertJiraDraft", () => {
  it("should tidy the summary and refuse a type, summary, assignee or description that can't be sent", () => {
    const types = ["Task", "Bug"];
    expect(assertJiraDraft({ ...DRAFT, summary: "  Send\nDana  the keys " }, types).summary).toBe("Send Dana the keys");
    expect(() => assertJiraDraft({ ...DRAFT, issueType: "Epic" }, types)).toThrow(/type of ticket/);
    expect(() => assertJiraDraft({ ...DRAFT, summary: " " }, types)).toThrow(/summary/);
    expect(() => assertJiraDraft({ ...DRAFT, summary: "x".repeat(256) }, types)).toThrow(/summary/);
    expect(() => assertJiraDraft({ ...DRAFT, description: "x".repeat(30_001) }, types)).toThrow(/description/);
    expect(() => assertJiraDraft({ ...DRAFT, assignee: { accountId: "../x", displayName: "Dana" } }, types)).toThrow(/assign/);
    expect(() => assertJiraDraft(null, types)).toThrow(/Not a Jira ticket/);
  });
});

describe("assertJiraSettingsInput", () => {
  it("should tidy the site and project key, and refuse settings that can't work", () => {
    expect(assertJiraSettingsInput({ ...INPUT, issueTypes: [" Task", "Bug ", "Task"] })).toEqual({
      site: SITE,
      email: "me@example.com",
      projectKey: "QI",
      issueTypes: ["Task", "Bug"],
      token: "secret-token",
    });
    expect(() => assertJiraSettingsInput({ ...INPUT, site: "http://example.atlassian.net" })).toThrow(/https address/);
    expect(() => assertJiraSettingsInput({ ...INPUT, site: `${SITE}/wiki` })).toThrow(/https address/);
    expect(() => assertJiraSettingsInput({ ...INPUT, email: "me" })).toThrow(/email/);
    expect(() => assertJiraSettingsInput({ ...INPUT, projectKey: "Q I" })).toThrow(/project key/);
    expect(() => assertJiraSettingsInput({ ...INPUT, issueTypes: [" "] })).toThrow(/types of ticket/);
    expect(() => assertJiraSettingsInput({ ...INPUT, issueTypes: [] })).toThrow(/types of ticket/);
    expect(() => assertJiraSettingsInput({ ...INPUT, issueTypes: "Task" })).toThrow(/types of ticket/);
    expect(() => assertJiraSettingsInput({ ...INPUT, token: " " })).toThrow(/API token/);
    expect(() => assertJiraSettingsInput(null)).toThrow(/Not Jira settings/);
  });
});

/**
 * One issue as Jira's search sent it on 2026-11-13, cut down to the fields read.
 * @param key The ticket.
 * @param status Its status and status group.
 * @param sprints Its sprints, as name:state.
 * @returns The issue.
 */
function searchIssue(key: string, status: [string, string], sprints: string[]) {
  return {
    key,
    fields: {
      summary: `Summary of ${key}`,
      issuetype: { name: "Task" },
      status: { name: status[0], statusCategory: { key: status[1] } },
      customfield_10010: sprints.map((sprint) => ({ name: sprint.split(":")[0], state: sprint.split(":")[1] })),
    },
  };
}

describe("listMySprintTickets", () => {
  it("should list your tickets in the open sprints in the board's order, finished ones last, with the sprints named", async () => {
    const stores = fakeStores();
    stores.rawSettings.set(JIRA_KEYS.email, "me@example.com");
    stores.rawSecrets.set(JIRA_KEYS.token, "t");
    const { fetchJira, calls } = fakeFetch({
      "GET /rest/api/3/field": { body: [{ id: "summary", schema: {} }, { id: "customfield_10010", schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" } }] },
      "GET /rest/api/3/search/jql": {
        body: {
          isLast: true,
          issues: [
            searchIssue("QI-15897", ["Done", "done"], ["PØD-2026-22:active", "PØD-2026-21:closed"]),
            searchIssue("QI-15698", ["In Testing / Development", "indeterminate"], ["PØD-2026-22:active", "PØD-2026-21:closed"]),
            searchIssue("QI-16579", ["Backlog", "new"], ["PØD-2026-22:active"]),
            { key: 7 },
          ],
        },
      },
    });

    const report = await listMySprintTickets({ ...stores, fetch: fetchJira });

    expect(report.problem).toBeNull();
    expect(report.sprints).toEqual(["PØD-2026-22"]);
    expect(report.tickets.map((ticket) => [ticket.key, ticket.statusCategory])).toEqual([
      ["QI-15698", "indeterminate"],
      ["QI-16579", "new"],
      ["QI-15897", "done"],
    ]);
    expect(report.tickets[0]).toEqual({
      key: "QI-15698",
      summary: "Summary of QI-15698",
      type: "Task",
      status: "In Testing / Development",
      statusCategory: "indeterminate",
      // No site saved, so the default (QbDVision's) is used.
      url: "https://cherrycircle.atlassian.net/browse/QI-15698",
    });
    const search = new URL(calls[1].url).searchParams;
    expect(search.get("jql")).toBe("assignee = currentUser() AND sprint in openSprints() ORDER BY Rank ASC");
    expect(search.get("fields")).toBe("summary,status,issuetype,customfield_10010");
  });

  it("should say why instead of failing when Jira isn't set up or refuses", async () => {
    const empty = fakeStores();
    expect(await listMySprintTickets({ ...empty, fetch: fakeFetch({}).fetchJira })).toEqual({ tickets: [], sprints: [], problem: "Set up Jira in Settings first." });

    const stores = fakeStores();
    stores.rawSettings.set(JIRA_KEYS.email, "me@example.com");
    stores.rawSecrets.set(JIRA_KEYS.token, "t");
    const refused = fakeFetch({ "GET /rest/api/3/field": { status: 401, body: {} } });
    expect((await listMySprintTickets({ ...stores, fetch: refused.fetchJira })).problem).toMatch(/didn't accept/);
  });
});
