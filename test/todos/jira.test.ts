import { MAX_HANDOFF_TICKETS } from "../../src/shared/ipc";
import {
  JIRA_KEYS,
  assertJiraSettingsInput,
  jiraUnavailable,
  listMySprintTickets,
  listTicketMoves,
  moveTicket,
  startTickets,
  readJiraSettings,
  readTicketBriefs,
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
    // A 204 (what Jira sends after a move) has no body at all.
    return new Response(answer.status === 204 ? null : JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchJira, calls };
}

const INPUT = { site: `${SITE}/`, email: "me@example.com", projectKey: "qi", issueTypes: ["Task"], token: "secret-token" };

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
    expect(search.get("jql")).toBe(
      'assignee = currentUser() AND sprint in openSprints() AND status NOT IN ("Merged to Master", "Released to Standard", "Released to Validated") ORDER BY Rank ASC',
    );
    expect(search.get("fields")).toBe("summary,status,issuetype,customfield_10010");
  });

  it("should offer each state a ticket can move to once, then move it and read the list again", async () => {
    const stores = fakeStores();
    stores.rawSettings.set(JIRA_KEYS.email, "me@example.com");
    stores.rawSecrets.set(JIRA_KEYS.token, "t");
    // Cut down from QI-16807's real transitions on 2026-11-13.
    const move = (id: string, to: string, category: string) => ({ id, name: to, to: { name: to, statusCategory: { key: category } } });
    const { fetchJira, calls } = fakeFetch({
      "GET /rest/api/3/issue/QI-16807/transitions": {
        body: { transitions: [move("51", "Backlog", "new"), move("31", "In Testing / Development", "indeterminate"), move("71", "Final Signoff", "done"), move("181", "Backlog", "new"), { id: 9 }] },
      },
      "POST /rest/api/3/issue/QI-16807/transitions": { status: 204, body: "" },
      "GET /rest/api/3/field": { body: [] },
      "GET /rest/api/3/search/jql": { body: { issues: [] } },
    });
    const deps = { ...stores, fetch: fetchJira };

    expect(await listTicketMoves(deps, "QI-16807")).toEqual([
      { id: "51", status: "Backlog", statusCategory: "new" },
      { id: "31", status: "In Testing / Development", statusCategory: "indeterminate" },
      { id: "71", status: "Final Signoff", statusCategory: "done" },
    ]);
    expect((await moveTicket(deps, "QI-16807", "31")).problem).toBeNull();
    const posted = calls.find((call) => call.init.method === "POST");
    expect(JSON.parse(String(posted?.init.body))).toEqual({ transition: { id: "31" } });
    expect(calls.at(-1)?.url).toContain("/rest/api/3/search/jql");
  });

  it("should refuse a ticket or move the window didn't get from Jira", async () => {
    const stores = fakeStores();
    stores.rawSettings.set(JIRA_KEYS.email, "me@example.com");
    stores.rawSecrets.set(JIRA_KEYS.token, "t");
    const { fetchJira, calls } = fakeFetch({});
    const deps = { ...stores, fetch: fetchJira };
    await expect(listTicketMoves(deps, "../myself")).rejects.toThrow(/Not a Jira ticket/);
    await expect(moveTicket(deps, "QI-1", "31; drop")).rejects.toThrow(/Not a state/);
    expect(calls).toHaveLength(0);
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

describe("readTicketBriefs", () => {
  it("should read each ticket's summary, type, status and description as text, in the order asked", async () => {
    const stores = fakeStores();
    stores.rawSettings.set(JIRA_KEYS.site, SITE);
    stores.rawSettings.set(JIRA_KEYS.email, "me@example.com");
    stores.rawSecrets.set(JIRA_KEYS.token, "t");
    const issue = (summary: string, description: unknown) => ({
      body: { fields: { summary, issuetype: { name: "Bug" }, status: { name: "In Draft" }, description } },
    });
    const { fetchJira, calls } = fakeFetch({
      "GET /rest/api/3/issue/QI-2": issue("Export drops rows", {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "Steps to reproduce" }] }],
      }),
      "GET /rest/api/3/issue/QI-1": issue("Fix the login", null),
    });

    const briefs = await readTicketBriefs({ ...stores, fetch: fetchJira }, ["QI-2", "QI-1", "QI-2"]);

    expect(briefs).toEqual([
      { key: "QI-2", summary: "Export drops rows", type: "Bug", status: "In Draft", url: `${SITE}/browse/QI-2`, description: "Steps to reproduce" },
      { key: "QI-1", summary: "Fix the login", type: "Bug", status: "In Draft", url: `${SITE}/browse/QI-1`, description: "" },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("fields=summary,issuetype,status,description");
  });

  it("should refuse anything but a short list of ticket keys before calling Jira", async () => {
    const { fetchJira, calls } = fakeFetch({});
    const deps = { ...fakeStores(), fetch: fetchJira };

    await expect(readTicketBriefs(deps, [])).rejects.toThrow(/Pick from 1 to/);
    await expect(readTicketBriefs(deps, "QI-1")).rejects.toThrow(/Pick from 1 to/);
    await expect(readTicketBriefs(deps, ["QI-1", "../myself"])).rejects.toThrow(/Not a Jira ticket/);
    await expect(readTicketBriefs(deps, Array.from({ length: MAX_HANDOFF_TICKETS + 1 }, (_, i) => `QI-${i}`))).rejects.toThrow(/Pick from 1 to/);
    expect(calls).toHaveLength(0);
  });
});

describe("startTickets", () => {
  /** Jira set up, answering each ticket's status and moves from a table. */
  function setUp(statuses: Record<string, string>, withStartMove = true) {
    const stores = fakeStores();
    stores.rawSettings.set(JIRA_KEYS.email, "me@example.com");
    stores.rawSecrets.set(JIRA_KEYS.token, "t");
    const move = (id: string, to: string) => ({ id, name: to, to: { name: to, statusCategory: { key: "indeterminate" } } });
    const answers: Record<string, { status?: number; body: unknown }> = {};
    for (const [key, status] of Object.entries(statuses)) {
      answers[`GET /rest/api/3/issue/${key}`] = { body: { fields: { status: { name: status } } } };
      answers[`GET /rest/api/3/issue/${key}/transitions`] = {
        body: { transitions: [move("11", "PR Review"), ...(withStartMove ? [move("31", "In Testing / Development")] : [])] },
      };
      answers[`POST /rest/api/3/issue/${key}/transitions`] = { status: 204, body: "" };
    }
    const { fetchJira, calls } = fakeFetch(answers);
    return { deps: { ...stores, fetch: fetchJira }, calls };
  }

  it("should move tickets not started yet to In Testing / Development, and leave the rest where they are", async () => {
    const { deps, calls } = setUp({ "QI-1": "Backlog", "QI-2": "Detailed Design", "QI-3": "PR Review", "QI-4": "QA Signed Off" });

    expect(await startTickets(deps, ["QI-1", "QI-2", "QI-3", "QI-4"])).toEqual({ moved: ["QI-1", "QI-2"], problems: [] });
    const posts = calls.filter((call) => call.init.method === "POST");
    expect(posts.map((call) => new URL(call.url).pathname)).toEqual(["/rest/api/3/issue/QI-1/transitions", "/rest/api/3/issue/QI-2/transitions"]);
    expect(JSON.parse(String(posts[0].init.body))).toEqual({ transition: { id: "31" } });
  });

  it("should say so, and move nothing, when the workflow has no move to In Testing / Development", async () => {
    const { deps, calls } = setUp({ "QI-1": "In Draft" }, false);

    expect(await startTickets(deps, ["QI-1"])).toEqual({ moved: [], problems: ["QI-1: no move from In Draft to In Testing / Development"] });
    expect(calls.some((call) => call.init.method === "POST")).toBe(false);
  });

  it("should carry on past a ticket Jira can't read, and do nothing when Jira isn't set up", async () => {
    const { deps } = setUp({ "QI-2": "Backlog" });
    const result = await startTickets(deps, ["QI-1", "QI-2"]);
    expect(result.moved).toEqual(["QI-2"]);
    expect(result.problems).toEqual([expect.stringMatching(/^QI-1: /)]);

    const { fetchJira, calls } = fakeFetch({});
    expect(await startTickets({ ...fakeStores(), fetch: fetchJira }, ["QI-1"])).toEqual({ moved: [], problems: [] });
    expect(calls).toHaveLength(0);
  });
});
