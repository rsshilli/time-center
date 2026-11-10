import type { Todo } from "../../src/shared/ipc";
import { JIRA_KEYS, assertJiraSettingsInput, createJiraTicket, jiraUnavailable, readJiraSettings, saveJiraSettings } from "../../src/main/todos/jira";

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

const INPUT = { site: `${SITE}/`, email: "me@example.com", projectKey: "qi", issueType: "Task", token: "secret-token" };

const TODO: Todo = {
  id: 1,
  markdown: "Send **Dana** the [keys](https://x.y)\n\n- by Friday",
  section: "work",
  createdAt: 0,
  doneAt: null,
  source: { recordingId: 4, title: "Weekly sync", saidAt: new Date(2026, 10, 10, 10, 2).getTime() },
  sent: [],
};

describe("jira", () => {
  it("should show QbDVision's Jira, QI and Task before anything is saved, and say Jira isn't set up", () => {
    const stores = fakeStores();
    expect(readJiraSettings(stores)).toEqual({ site: "https://cherrycircle.atlassian.net", email: "", projectKey: "QI", issueType: "Task", hasToken: false });
    expect(jiraUnavailable(stores)).toMatch(/Set up Jira/);
  });

  it("should check the settings against Jira, then save them with the token kept as a secret", async () => {
    const stores = fakeStores();
    const { fetchJira, calls } = fakeFetch({
      "GET /rest/api/3/myself": { body: { accountId: "abc" } },
      "GET /rest/api/3/issue/createmeta/QI/issuetypes": { body: { issueTypes: [{ name: "Task" }, { name: "Bug" }] } },
    });

    const saved = await saveJiraSettings({ ...stores, fetch: fetchJira }, INPUT);

    expect(saved).toEqual({ site: SITE, email: "me@example.com", projectKey: "QI", issueType: "Task", hasToken: true });
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
    await expect(saveJiraSettings({ ...stores, fetch: noType.fetchJira }, INPUT)).rejects.toThrow(/QI has no "Task" type. It has: Bug/);

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
      "GET /rest/api/3/myself": { body: { accountId: "abc" } },
      "POST /rest/api/3/issue": { body: { key: "../../evil" } },
    });

    await expect(createJiraTicket({ ...stores, fetch: fetchJira }, { id: 1, markdown: "Do it", section: "work", createdAt: 0, doneAt: null, source: null, sent: [] })).rejects.toThrow(/didn't say which ticket/);
  });

  it("should make a ticket assigned to you, with the first line as summary and the item and call as description", async () => {
    const stores = fakeStores();
    stores.rawSettings.set(JIRA_KEYS.site, SITE);
    stores.rawSettings.set(JIRA_KEYS.email, "me@example.com");
    stores.rawSecrets.set(JIRA_KEYS.token, "secret-token");
    const { fetchJira, calls } = fakeFetch({
      "GET /rest/api/3/myself": { body: { accountId: "abc" } },
      "POST /rest/api/3/issue": { status: 201, body: { key: "QI-1234" } },
    });

    const sent = await createJiraTicket({ ...stores, fetch: fetchJira }, TODO);

    expect(sent).toEqual({ action: "jira", label: "QI-1234", url: `${SITE}/browse/QI-1234` });
    const body = JSON.parse(String(calls[1].init.body)) as { fields: Record<string, unknown> };
    expect(body.fields.project).toEqual({ key: "QI" });
    expect(body.fields.issuetype).toEqual({ name: "Task" });
    expect(body.fields.summary).toBe("Send Dana the keys");
    expect(body.fields.assignee).toEqual({ accountId: "abc" });
    const description = JSON.stringify(body.fields.description);
    expect(description).toContain('"type":"bulletList"');
    expect(description).toContain('{"type":"link","attrs":{"href":"https://x.y"}}');
    expect(description).toContain("From the call \\\"Weekly sync\\\"");
  });

  it("should pass on Jira's own words when it refuses a ticket", async () => {
    const stores = fakeStores();
    stores.rawSettings.set(JIRA_KEYS.email, "me@example.com");
    stores.rawSecrets.set(JIRA_KEYS.token, "t");
    const { fetchJira } = fakeFetch({
      "GET /rest/api/3/myself": { body: {} },
      "POST /rest/api/3/issue": { status: 400, body: { errors: { components: "Component is required." } } },
    });

    await expect(createJiraTicket({ ...stores, fetch: fetchJira }, TODO)).rejects.toThrow("Jira said: components: Component is required.");
  });
});

describe("assertJiraSettingsInput", () => {
  it("should tidy the site and project key, and refuse settings that can't work", () => {
    expect(assertJiraSettingsInput(INPUT)).toEqual({ site: SITE, email: "me@example.com", projectKey: "QI", issueType: "Task", token: "secret-token" });
    expect(() => assertJiraSettingsInput({ ...INPUT, site: "http://example.atlassian.net" })).toThrow(/https address/);
    expect(() => assertJiraSettingsInput({ ...INPUT, site: `${SITE}/wiki` })).toThrow(/https address/);
    expect(() => assertJiraSettingsInput({ ...INPUT, email: "me" })).toThrow(/email/);
    expect(() => assertJiraSettingsInput({ ...INPUT, projectKey: "Q I" })).toThrow(/project key/);
    expect(() => assertJiraSettingsInput({ ...INPUT, issueType: " " })).toThrow(/type of ticket/);
    expect(() => assertJiraSettingsInput({ ...INPUT, token: " " })).toThrow(/API token/);
    expect(() => assertJiraSettingsInput(null)).toThrow(/Not Jira settings/);
  });
});
