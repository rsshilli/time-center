import type { StoredSegment } from "../../src/main/activity/ActivityStore";
import {
  buildWorkLog,
  defaultPeriod,
  duration,
  readPeriod,
  ticketsSection,
  titlesSection,
  todosSection,
  type WorkLogDeps,
} from "../../src/main/recording/workLog";
import { readTicketActivity } from "../../src/main/todos/jira";
import type { RangeReport, Todo } from "../../src/shared/ipc";

const NOW = new Date(2026, 10, 18, 14).getTime();
const MIN = 60_000;

/** Haiku's tool call with these inputs. */
const toolReply = (input: object) => ({ content: [{ type: "tool_use", name: "set_period", input }] });

/** An active stretch in one window. */
function segment(title: string | null, minutes: number, kind: StoredSegment["kind"] = "active"): StoredSegment {
  return { id: 1, startedAt: NOW, endedAt: NOW + minutes * MIN, kind, app: "Google Chrome", bundleId: null, title, url: null, domain: "github.com", project: null };
}

/** A TODO added and maybe ticked at these times. */
function todo(markdown: string, createdAt: number, doneAt: number | null): Todo {
  return { id: 1, markdown, section: "work", createdAt, doneAt, source: null, sent: [] };
}

describe("readPeriod", () => {
  it("should read the days Haiku named, from local midnight to the midnight after the last day", () => {
    expect(readPeriod(toolReply({ about_a_period: true, from: "2026-11-09", to: "2026-11-15" }), NOW)).toEqual({
      from: new Date(2026, 10, 9).getTime(),
      to: new Date(2026, 10, 16).getTime(),
    });
  });

  it("should stop a stretch running past today at the end of today", () => {
    expect(readPeriod(toolReply({ about_a_period: true, from: "2026-11-16", to: "2026-11-22" }), NOW)?.to).toBe(new Date(2026, 10, 19).getTime());
  });

  it("should read no stretch when the question names none, the dates are wrong, or it's too long", () => {
    expect(readPeriod(toolReply({ about_a_period: false }), NOW)).toBeNull();
    expect(readPeriod(toolReply({ about_a_period: true, from: "2026-11-31", to: "2026-12-01" }), NOW)).toBeNull();
    expect(readPeriod(toolReply({ about_a_period: true, from: "2026-11-15", to: "2026-11-09" }), NOW)).toBeNull();
    expect(readPeriod(toolReply({ about_a_period: true, from: "2026-01-01", to: "2026-11-01" }), NOW)).toBeNull();
    expect(readPeriod({ content: [{ type: "text", text: "last week" }] }, NOW)).toBeNull();
  });
});

describe("defaultPeriod", () => {
  it("should cover the last seven days, today included", () => {
    expect(defaultPeriod(NOW)).toEqual({ from: new Date(2026, 10, 12).getTime(), to: new Date(2026, 10, 19).getTime() });
  });
});

describe("titlesSection", () => {
  it("should add up time per window title, most first, leaving out idle time, untitled windows and blips", () => {
    const text = titlesSection([
      segment("QI-1 Fix it", 30),
      segment("Inbox", 50),
      segment("QI-1 Fix it", 40),
      segment("Lock screen", 500, "idle"),
      segment(null, 90),
      segment("Blip", 0.5),
    ]);

    expect(text.split("\n").slice(1)).toEqual(["- 1h 10m · Google Chrome · QI-1 Fix it (github.com)", "- 50m · Google Chrome · Inbox (github.com)"]);
  });
});

describe("todosSection", () => {
  it("should list the TODOs ticked in the stretch, and those added in it still open", () => {
    const period = { from: NOW - 60 * MIN, to: NOW + 60 * MIN };
    const text = todosSection(
      [todo("Ticked now", NOW - 999 * MIN, NOW), todo("Added now", NOW, null), todo("Old and open", NOW - 999 * MIN, null), todo("Ticked long ago", NOW - 999 * MIN, NOW - 500 * MIN)],
      period,
    );

    expect(text).toBe(["TODOs ticked done in this stretch:", "- Ticked now", "TODOs added in this stretch and not yet done:", "- Added now"].join("\n"));
  });
});

describe("ticketsSection", () => {
  it("should write each ticket's moves and who made them, or why Jira couldn't be read", () => {
    const text = ticketsSection({
      problem: null,
      tickets: [{ key: "QI-1", summary: "Fix it", type: "Task", status: "Merged to Master", createdByYouAt: null, moves: [{ at: NOW, from: "In Draft", to: "Merged to Master", by: "Ryan" }] }],
    });

    expect(text).toContain('- QI-1 (Task) "Fix it", now Merged to Master. Wed Nov 18: In Draft → Merged to Master (by Ryan).');
    expect(ticketsSection({ problem: "Jira is down", tickets: [] })).toContain("Couldn't read Jira: Jira is down");
  });
});

describe("buildWorkLog", () => {
  it("should put the time, titles, TODOs and tickets for the stretch in one work_log", async () => {
    const range: RangeReport = {
      from: NOW,
      to: NOW,
      days: [{ dayStart: new Date(2026, 10, 18).getTime(), activeMs: 125 * MIN, byCategory: [] }],
      activeMs: 125 * MIN,
      idleMs: 0,
      untrackedMs: 0,
      byCategory: [{ name: "Coding", ms: 90 * MIN }],
      byApp: [],
      byProject: [],
      byDomain: [],
      byMeeting: [],
    };
    const tickets = vi.fn<WorkLogDeps["tickets"]>(async () => ({ tickets: [], problem: null }));
    const period = { from: new Date(2026, 10, 18).getTime(), to: new Date(2026, 10, 19).getTime() };

    const text = await buildWorkLog({ range: () => range, segments: () => [segment("QI-9", 5)], todos: () => [], tickets }, period);

    expect(tickets).toHaveBeenCalledWith(period.from, period.to);
    expect(text.startsWith('<work_log from="Wednesday, November 18, 2026" to="Wednesday, November 18, 2026">')).toBe(true);
    expect(text).toContain("- By day: Wed Nov 18 2h 05m.");
    expect(text).toContain("- By category: Coding 1h 30m.");
    expect(text).toContain("QI-9");
    expect(text.endsWith("</work_log>")).toBe(true);
  });
});

describe("duration", () => {
  it("should write minutes alone under an hour, and hours with two-digit minutes after", () => {
    expect([duration(12 * MIN), duration(65 * MIN), duration(0)]).toEqual(["12m", "1h 05m", "0m"]);
  });
});

describe("readTicketActivity", () => {
  const from = new Date(2026, 10, 9).getTime();
  const to = new Date(2026, 10, 16).getTime();
  /** A Jira search issue with a changelog. */
  const issue: unknown = {
    key: "QI-5",
    fields: { summary: "Ship it", issuetype: { name: "Bug" }, status: { name: "Merged to Master" }, created: "2026-11-10T10:00:00.000+0000", reporter: { accountId: "me" } },
    changelog: {
      histories: [
        { created: "2026-11-12T10:00:00.000+0000", author: { displayName: "Ryan" }, items: [{ field: "status", fromString: "In Draft", toString: "In Testing" }, { field: "assignee" }] },
        { created: "2026-11-02T10:00:00.000+0000", author: { displayName: "Ryan" }, items: [{ field: "status", fromString: "Backlog", toString: "In Draft" }] },
        { created: "2026-11-11T10:00:00.000+0000", author: {}, items: [{ field: "status", fromString: "Backlog", toString: "In Draft" }] },
      ],
    },
  };

  it("should keep only the status changes inside the stretch, earliest first, and say who made them", () => {
    expect(readTicketActivity(issue, from, to, "me")?.moves.map((move) => `${move.from}→${move.to} ${move.by}`)).toEqual([
      "Backlog→In Draft someone",
      "In Draft→In Testing Ryan",
    ]);
  });

  it("should mark a ticket you created in the stretch, and not one someone else created", () => {
    expect(readTicketActivity(issue, from, to, "me")?.createdByYouAt).toBe(Date.parse("2026-11-10T10:00:00.000+0000"));
    expect(readTicketActivity(issue, from, to, "someone-else")?.createdByYouAt).toBeNull();
  });

  it("should skip an issue with no key", () => {
    expect(readTicketActivity({ fields: {} }, from, to, null)).toBeNull();
  });
});
