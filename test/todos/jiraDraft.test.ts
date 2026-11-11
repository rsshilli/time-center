import type { JiraDraft, JiraSprint, Todo, TranscriptLine } from "../../src/shared/ipc";
import { isUnderWay, nextSprint, sprintTeam } from "../../src/shared/jiraSprints";
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

/** The day the tests run on. */
const NOW = Date.UTC(2026, 10, 11, 18);

/**
 * Open sprints as Jira lists them: Platform's month under way and the next; PØD's sprint whose start date has
 * passed though Jira hasn't started it, and the one after.
 */
const SPRINTS = [
  { id: 1652, name: "Platform - November", state: "active", startDate: "2026-11-02T15:00:00.000Z", endDate: "2026-12-01T15:00:00.000Z" },
  { id: 1653, name: "Platform - December", state: "future", startDate: "2026-12-01T15:00:00.000Z", endDate: "2026-12-31T15:00:00.000Z" },
  { id: 1689, name: "PØD-2026-22", state: "future", startDate: "2026-11-10T15:00:00.000Z", endDate: "2026-11-23T15:00:00.000Z" },
  { id: 1690, name: "PØD-2026-23", state: "future", startDate: "2026-11-24T15:00:00.000Z", endDate: "2026-12-08T15:00:00.000Z" },
];

/** A fetch answering QI's ticket types, the Engineering Team field, you, and a search for Dana. */
function fakeJira(found: unknown[] = [{ accountId: "dana-1", displayName: "Dana Scully" }]) {
  const paths: string[] = [];
  const answers: Record<string, unknown> = {
    "/rest/api/3/myself": { accountId: "me-1", displayName: "Ryan Shillington" },
    "/rest/api/3/issue/createmeta/QI/issuetypes": { issueTypes: [{ id: "10001", name: "Task" }, { id: "10004", name: "Bug" }] },
    "/rest/api/3/issue/createmeta/QI/issuetypes/10001": {
      fields: [
        { fieldId: "customfield_10206", name: "Engineering Team", allowedValues: [{ value: "Platform" }, { value: "PØD" }, { value: "Support" }] },
        { fieldId: "customfield_10010", name: "Sprint", schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" } },
      ],
    },
    "/rest/api/3/issue/createmeta/QI/issuetypes/10004": { fields: [{ fieldId: "customfield_10206", name: "Engineering Team", allowedValues: [{ value: "Platform" }, { value: "Bug" }] }] },
    "/rest/api/3/user/assignable/search": found,
    "/rest/agile/1.0/board": { values: [{ id: 1 }], isLast: true },
    "/rest/agile/1.0/board/1/sprint": { values: SPRINTS, isLast: true },
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
    now: () => NOW,
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
        assignee: { accountId: "dana-1", displayName: "Dana Scully" },
        team: "Platform",
        // Bugs have no Sprint field in this fake project.
        sprint: null,
      },
      issueTypes: ["Task", "Bug"],
      teamsByType: { Task: ["Platform", "PØD", "Support"], Bug: ["Platform", "Bug"] },
      sprints: [
        { id: 1652, name: "Platform - November", state: "active", start: Date.parse("2026-11-02T15:00:00.000Z"), end: Date.parse("2026-12-01T15:00:00.000Z"), team: "Platform" },
        { id: 1689, name: "PØD-2026-22", state: "future", start: Date.parse("2026-11-10T15:00:00.000Z"), end: Date.parse("2026-11-23T15:00:00.000Z"), team: "PØD" },
        { id: 1690, name: "PØD-2026-23", state: "future", start: Date.parse("2026-11-24T15:00:00.000Z"), end: Date.parse("2026-12-08T15:00:00.000Z"), team: "PØD" },
        { id: 1653, name: "Platform - December", state: "future", start: Date.parse("2026-12-01T15:00:00.000Z"), end: Date.parse("2026-12-31T15:00:00.000Z"), team: "Platform" },
      ],
      sprintTypes: ["Task"],
      note: null,
    });
    const prompt = requests[0].messages[0].content;
    expect(prompt).toContain("Dana will send the keys to the vendor.");
    expect(prompt).toContain('Engineering Teams: ["Platform","PØD","Support"]');
    expect(prompt).toContain('The usual teams: ["PØD","Platform"]');
    expect(prompt).toContain("You are writing for Ryan Shillington.");
  });

  it("should fall back to Jira's choices and you when Sonnet names a type or team that doesn't exist", async () => {
    const { deps } = fakeDeps('{"issueType": "Admin", "summary": "Do it", "description": "x", "assignee": null, "team": "Wizards", "accountId": "evil"}');

    const { draft } = await draftJiraTicket(deps, TODO, null, null);

    expect(draft.issueType).toBe("Task");
    expect(draft.team).toBe("PØD");
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
      sprint: null,
    };
    const { deps, requests, paths } = fakeDeps('{"issueType": "Task", "summary": "Send the vendor the keys by Friday", "description": "x", "assignee": "Dana Scully", "team": "Support"}');

    const result = await draftJiraTicket(deps, TODO, current, "say it's due Friday");

    expect(result.draft).toMatchObject({ summary: "Send the vendor the keys by Friday", assignee: { accountId: "dana-2" }, team: "Support" });
    expect(requests[0].messages[0].content).toContain("Change the draft like this: say it's due Friday");
    expect(requests[0].messages[0].content).toContain('"assignee":"Dana Scully"');
    expect(paths.some((path) => path.startsWith("/rest/api/3/user/assignable/search"))).toBe(false);
  });

  it("should keep the assignee and team picked by hand when Sonnet's change leaves them out", async () => {
    const current: JiraDraft = { issueType: "Task", summary: "s", description: "d", assignee: { accountId: "fox-1", displayName: "Fox Mulder" }, team: "Support", sprint: null };
    const { deps } = fakeDeps('{"issueType": "Task", "summary": "Shorter", "description": "d", "assignee": null}');

    const { draft, note } = await draftJiraTicket(deps, TODO, current, "shorten the summary");

    expect(draft).toMatchObject({ summary: "Shorter", assignee: { accountId: "fox-1" }, team: "Support" });
    expect(note).toBeNull();
    const unassigned = await draftJiraTicket(deps, TODO, { ...current, assignee: null }, "shorten the summary");
    expect(unassigned.draft.assignee).toBeNull();
  });

  it("should keep the person picked, and say so, when Sonnet names someone Jira can't find on a change", async () => {
    const current: JiraDraft = { issueType: "Task", summary: "s", description: "d", assignee: { accountId: "fox-1", displayName: "Fox Mulder" }, team: null, sprint: null };
    const { deps } = fakeDeps('{"issueType": "Task", "summary": "s", "description": "d", "assignee": "Walter Skinner", "team": null}', []);

    const result = await draftJiraTicket(deps, TODO, current, "give it to Walter");

    expect(result.draft.assignee?.accountId).toBe("fox-1");
    expect(result.note).toBe('Couldn\'t find "Walter Skinner" in Jira, so it\'s assigned to Fox Mulder.');
  });

  it("should take a single loose match from Jira's search, with a note to check it", async () => {
    const { deps } = fakeDeps('{"issueType": "Task", "summary": "s", "description": "d", "assignee": "Dana", "team": null}');

    const result = await draftJiraTicket(deps, TODO, null, null);

    expect(result.draft.assignee?.accountId).toBe("dana-1");
    expect(result.note).toBe('Assigned to Dana Scully, the closest match for "Dana". Check it\'s the right person.');
  });

  it("should keep a bug's sections when its description is too long, cutting the text instead", async () => {
    const long = "x".repeat(40_000);
    const { deps } = fakeDeps(JSON.stringify({ issueType: "Bug", summary: "s", description: long, assignee: null, team: null }));

    const { draft } = await draftJiraTicket(deps, TODO, null, null);

    expect(draft.description.length).toBeLessThanOrEqual(30_000);
    expect(draft.description).toContain("## Expected / Actual");
  });

  it("should leave it unassigned when asked, and refuse a change with no words", async () => {
    const current: JiraDraft = { issueType: "Task", summary: "s", description: "d", assignee: null, team: null, sprint: null };
    const { deps } = fakeDeps('{"issueType": "Task", "summary": "s", "description": "d", "assignee": "unassigned", "team": null}');

    expect((await draftJiraTicket(deps, TODO, current, "leave it unassigned")).draft.assignee).toBeNull();
    await expect(draftJiraTicket(deps, TODO, current, "  ")).rejects.toThrow(/what to change/);
  });

  it("should put a PØD ticket in the sprint after the one whose start date has passed, even if Jira hasn't started it", async () => {
    const { deps } = fakeDeps('{"issueType": "Task", "summary": "s", "description": "d", "assignee": null, "team": "PØD"}');

    const { draft } = await draftJiraTicket(deps, TODO, null, null);

    expect(draft).toMatchObject({ team: "PØD", sprint: 1690 });
    const platform = fakeDeps('{"issueType": "Task", "summary": "s", "description": "d", "assignee": null, "team": "Platform"}');
    // Platform's next month, not the one under way.
    expect((await draftJiraTicket(platform.deps, TODO, null, null)).draft).toMatchObject({ team: "Platform", sprint: 1653 });
  });

  it("should keep the sprint picked on a change, and move to the new team's next sprint when the team changes", async () => {
    const current: JiraDraft = { issueType: "Task", summary: "s", description: "d", assignee: null, team: "Platform", sprint: 1652 };
    const same = fakeDeps('{"issueType": "Task", "summary": "Shorter", "description": "d", "assignee": null, "team": "Platform"}');
    const moved = fakeDeps('{"issueType": "Task", "summary": "s", "description": "d", "assignee": null, "team": "PØD"}');

    expect((await draftJiraTicket(same.deps, TODO, current, "shorten it")).draft.sprint).toBe(1652);
    expect((await draftJiraTicket(moved.deps, TODO, current, "give it to PØD")).draft.sprint).toBe(1690);
  });

  it("should give a first draft PØD or Platform when Sonnet names no team or one Jira doesn't offer", async () => {
    for (const team of ["null", '"Wizards"']) {
      const { deps } = fakeDeps(`{"issueType": "Task", "summary": "s", "description": "d", "assignee": null, "team": ${team}}`);
      expect((await draftJiraTicket(deps, TODO, null, null)).draft).toMatchObject({ team: "PØD", sprint: 1690 });
    }
  });

  it("should keep the sprint picked when Jira's sprints can't be read on a change", async () => {
    const current: JiraDraft = { issueType: "Task", summary: "s", description: "d", assignee: null, team: "Platform", sprint: 1652 };
    const { deps } = fakeDeps('{"issueType": "Task", "summary": "Shorter", "description": "d", "assignee": null, "team": "Platform"}');
    const fetchJira = deps.jira.fetch;
    deps.jira.fetch = (async (url: string, init: RequestInit) =>
      new URL(url).pathname.startsWith("/rest/agile/") ? new Response("{}", { status: 500 }) : fetchJira(url, init)) as unknown as typeof fetch;

    const result = await draftJiraTicket(deps, TODO, current, "shorten it");

    expect(result.draft.sprint).toBe(1652);
    expect(result.note).toBeNull();
  });

  it("should put no sprint on a type whose create screen has no Sprint field", async () => {
    const { deps } = fakeDeps('{"issueType": "Bug", "summary": "s", "description": "d", "assignee": null, "team": "Platform"}');

    const result = await draftJiraTicket(deps, TODO, null, null);

    expect(result.sprintTypes).toEqual(["Task"]);
    expect(result.draft).toMatchObject({ issueType: "Bug", team: "Platform", sprint: null });
  });

  it("should still draft into the backlog, and say so, when Jira's sprints can't be read", async () => {
    const { deps } = fakeDeps('{"issueType": "Task", "summary": "s", "description": "d", "assignee": null, "team": "Platform"}');
    const fetchJira = deps.jira.fetch;
    deps.jira.fetch = (async (url: string, init: RequestInit) =>
      new URL(url).pathname.startsWith("/rest/agile/") ? new Response("{}", { status: 500 }) : fetchJira(url, init)) as unknown as typeof fetch;

    const result = await draftJiraTicket(deps, TODO, null, null);

    expect(result.draft).toMatchObject({ team: "Platform", sprint: null });
    expect(result.sprints).toEqual([]);
    expect(result.note).toBe("Couldn't read the sprints from Jira, so it goes in the backlog.");
  });
});

describe("nextSprint", () => {
  it("should give no sprint without a team, or for a team with none to come", () => {
    const sprints: JiraSprint[] = [{ id: 1, name: "Platform - November", state: "active", start: 0, end: NOW + 1, team: "Platform" }];
    expect(nextSprint(sprints, null, NOW)).toBeNull();
    expect(nextSprint(sprints, "Platform", NOW)).toBeNull();
    expect(nextSprint(sprints, "PØD", NOW)).toBeNull();
  });

  it("should fall back to the team's first undated sprint when none to come has dates", () => {
    const sprints: JiraSprint[] = [
      { id: 7, name: "PØD later", state: "future", start: null, end: null, team: "PØD" },
      { id: 5, name: "PØD next", state: "future", start: null, end: null, team: "PØD" },
    ];
    expect(nextSprint(sprints, "PØD", NOW)).toBe(5);
  });
});

describe("isUnderWay", () => {
  it("should go by the dates, not Jira's state, so a finished sprint left active isn't 'now'", () => {
    const day = 86_400_000;
    const sprint = (state: JiraSprint["state"], start: number, end: number): JiraSprint => ({ id: 1, name: "s", state, start, end, team: null });
    expect(isUnderWay(sprint("active", NOW - 15 * day, NOW - 2 * day), NOW)).toBe(false);
    expect(isUnderWay(sprint("future", NOW - day, NOW + 12 * day), NOW)).toBe(true);
  });
});

describe("sprintTeam", () => {
  it("should read the team from the start of a sprint's name, ignoring case, spaces and punctuation", () => {
    const teams = ["Platform", "PØD", "Dream Team", "ZENgineers", "Bug"];
    expect(sprintTeam("Platform - November", teams)).toBe("Platform");
    expect(sprintTeam("PØD-2026-22", teams)).toBe("PØD");
    expect(sprintTeam("Dream Team 2026-23", teams)).toBe("Dream Team");
    expect(sprintTeam("Zengineers 2026-24", teams)).toBe("ZENgineers");
    expect(sprintTeam("Performance", teams)).toBeNull();
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
