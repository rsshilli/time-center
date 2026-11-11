import type { JiraDraft, Todo, TranscriptLine } from "../../src/shared/ipc";
import { JIRA_KEYS } from "../../src/main/todos/jira";
import { draftJiraTicket, readProposal } from "../../src/main/todos/jiraDraft";

const SAID_AT = new Date(2026, 10, 10, 10, 2).getTime();

const TODO: Todo = {
  id: 1,
  markdown: "Send Dana the keys",
  section: "work",
  createdAt: 0,
  doneAt: null,
  source: { recordingId: 4, title: "Weekly sync", saidAt: SAID_AT },
  sent: [],
};

const LINES: TranscriptLine[] = [
  { side: "them", start: SAID_AT - 30_000, end: SAID_AT - 25_000, text: "Dana will send the keys to the vendor.", speakerId: null },
];

/** A fetch answering QI's ticket types, the Engineering Team field, you, and a search for Dana. */
function fakeJira(found: unknown[] = [{ accountId: "dana-1", displayName: "Dana Scully" }]) {
  const paths: string[] = [];
  const answers: Record<string, unknown> = {
    "/rest/api/3/myself": { accountId: "me-1", displayName: "Ryan Shillington" },
    "/rest/api/3/issue/createmeta/QI/issuetypes": { issueTypes: [{ id: "10001", name: "Task" }, { id: "10004", name: "Bug" }] },
    "/rest/api/3/issue/createmeta/QI/issuetypes/10001": { fields: [{ fieldId: "customfield_10206", name: "Engineering Team", allowedValues: [{ value: "Platform" }, { value: "Support" }] }] },
    "/rest/api/3/issue/createmeta/QI/issuetypes/10004": { fields: [{ fieldId: "customfield_10206", name: "Engineering Team", allowedValues: [{ value: "Platform" }, { value: "Bug" }] }] },
    "/rest/api/3/user/assignable/search": found,
  };
  const fetchJira = (async (url: string) => {
    const path = new URL(url).pathname;
    paths.push(new URL(url).pathname + new URL(url).search);
    return path in answers ? new Response(JSON.stringify(answers[path])) : new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchJira, paths };
}

/**
 * Everything drafting needs, with Sonnet answering the given reply.
 * @param reply What Sonnet writes.
 * @param found Who Jira's search for the assignee finds.
 * @returns The dependencies, the requests sent to Sonnet and the Jira paths asked for.
 */
function fakeDeps(reply: string, found?: unknown[]) {
  const settings = new Map<string, string>([
    [JIRA_KEYS.email, "me@example.com"],
    [JIRA_KEYS.issueTypes, JSON.stringify(["Task", "Bug"])],
  ]);
  const { fetchJira, paths } = fakeJira(found);
  const requests: { messages: { content: string }[]; system: string }[] = [];
  const deps = {
    jira: {
      settings: { getSetting: (key: string) => settings.get(key) ?? null, setSetting: () => undefined },
      secrets: { get: (name: string) => (name === JIRA_KEYS.token ? "token" : null), set: () => undefined },
      fetch: fetchJira,
    },
    claude: {
      invoke: async (body: object) => {
        requests.push(body as (typeof requests)[number]);
        return { content: [{ type: "text", text: reply }] };
      },
    },
    callTranscript: () => ({ lines: LINES, speakers: [] }),
  };
  return { deps, requests, paths };
}

describe("draftJiraTicket", () => {
  it("should propose the ticket Sonnet drafts, with the assignee's account from Jira's own search", async () => {
    const { deps, requests } = fakeDeps(
      'Here it is: {"issueType": "Bug", "summary": "Send the vendor the keys", "description": "Dana sends the keys.", "assignee": "Dana Scully", "team": "Platform"}',
    );

    const result = await draftJiraTicket(deps, TODO, null, null);

    expect(result).toEqual({
      draft: {
        issueType: "Bug",
        summary: "Send the vendor the keys",
        // A bug Sonnet wrote without the bug sections gets them added.
        description: "Dana sends the keys.\n\n## Steps to reproduce\n1. To be written.\n\n## Expected / Actual\nExpected: To be written.\n\nActual: To be written.",
        assignee: { accountId: "dana-1", displayName: "Dana Scully" }, team: "Platform" },
      issueTypes: ["Task", "Bug"],
      teams: ["Platform", "Bug"],
      note: null,
    });
    const prompt = requests[0].messages[0].content;
    expect(prompt).toContain("Dana will send the keys to the vendor.");
    expect(prompt).toContain('Engineering Teams: ["Platform","Support"]');
    expect(prompt).toContain("You are writing for Ryan Shillington.");
  });

  it("should fall back to Jira's choices and you when Sonnet names a type or team that doesn't exist", async () => {
    const { deps } = fakeDeps('{"issueType": "Admin", "summary": "Do it", "description": "x", "assignee": null, "team": "Wizards", "accountId": "evil"}');

    const { draft } = await draftJiraTicket(deps, TODO, null, null);

    expect(draft.issueType).toBe("Task");
    expect(draft.team).toBeNull();
    expect(draft.assignee).toEqual({ accountId: "me-1", displayName: "Ryan Shillington" });
  });

  it("should assign it to you and say so when Jira can't find the person Sonnet named", async () => {
    const { deps } = fakeDeps('{"issueType": "Task", "summary": "Do it", "description": "x", "assignee": "Fox Mulder", "team": null}', []);

    const result = await draftJiraTicket(deps, TODO, null, null);

    expect(result.draft.assignee?.accountId).toBe("me-1");
    expect(result.note).toBe('Couldn\'t find "Fox Mulder" in Jira, so it\'s assigned to you.');
  });

  it("should send the draft and the change asked for, and keep a picked assignee without searching again", async () => {
    const current: JiraDraft = {
      issueType: "Task",
      summary: "Send the keys",
      description: "x",
      assignee: { accountId: "dana-2", displayName: "Dana Scully" },
      team: null,
    };
    const { deps, requests, paths } = fakeDeps('{"issueType": "Task", "summary": "Send the vendor the keys by Friday", "description": "x", "assignee": "Dana Scully", "team": "Support"}');

    const result = await draftJiraTicket(deps, TODO, current, "say it's due Friday");

    expect(result.draft).toMatchObject({ summary: "Send the vendor the keys by Friday", assignee: { accountId: "dana-2" }, team: "Support" });
    expect(requests[0].messages[0].content).toContain("Change the draft like this: say it's due Friday");
    expect(requests[0].messages[0].content).toContain('"assignee":"Dana Scully"');
    expect(paths.some((path) => path.startsWith("/rest/api/3/user/assignable/search"))).toBe(false);
  });

  it("should leave it unassigned when asked, and refuse a change with no words", async () => {
    const current: JiraDraft = { issueType: "Task", summary: "s", description: "d", assignee: null, team: null };
    const { deps } = fakeDeps('{"issueType": "Task", "summary": "s", "description": "d", "assignee": "unassigned", "team": null}');

    expect((await draftJiraTicket(deps, TODO, current, "leave it unassigned")).draft.assignee).toBeNull();
    await expect(draftJiraTicket(deps, TODO, current, "  ")).rejects.toThrow(/what to change/);
  });
});

describe("readProposal", () => {
  it("should read the JSON out of the reply, and refuse a reply with none", () => {
    expect(readProposal('```json\n{"summary": "  Do it ", "team": 3}\n```')).toEqual({
      issueType: null,
      summary: "Do it",
      description: null,
      assignee: null,
      team: null,
    });
    expect(() => readProposal("I can't help with that.")).toThrow(/didn't send back a ticket/);
  });
});
