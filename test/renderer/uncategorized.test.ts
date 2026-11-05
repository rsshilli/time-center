import { categorize } from "../../src/main/activity/classify";
import type { TimelineItem } from "../../src/shared/ipc";
import { knownCategories, uncategorizedGroups, UNCATEGORIZED } from "../../src/renderer/uncategorized";

/** Where the next stretch starts; each stretch follows the one before. */
let clock = 0;

/**
 * Makes one stretch of a day.
 * @param minutes How long it lasted.
 * @param fields Anything to set on it.
 * @returns The stretch.
 */
const stretch = (minutes: number, fields: Partial<TimelineItem>): TimelineItem => {
  const start = clock;
  clock += minutes * 60_000;
  return {
    start,
    end: clock,
    kind: "active",
    category: UNCATEGORIZED,
    app: null,
    title: null,
    url: null,
    domain: null,
    project: null,
    ...fields,
  };
};

describe("uncategorizedGroups", () => {
  it("should group by website, then WebStorm project, then app, largest first", () => {
    const groups = uncategorizedGroups([
      stretch(5, { app: "Google Chrome", domain: "news.ycombinator.com", title: "Hacker News" }),
      stretch(20, { app: "WebStorm", project: "time-center", title: "time-center – PLAN.md" }),
      stretch(10, { app: "Google Chrome", domain: "news.ycombinator.com", title: "Show HN" }),
      stretch(3, { app: "Finder", title: "Downloads" }),
    ]);
    expect(groups.map(({ field, pattern, ms }) => ({ field, pattern, minutes: ms / 60_000 }))).toEqual([
      { field: "project", pattern: "time-center", minutes: 20 },
      { field: "domain", pattern: "news.ycombinator.com", minutes: 15 },
      { field: "app", pattern: "Finder", minutes: 3 },
    ]);
  });

  it("should leave out categorized time, away time and ignored-app time", () => {
    const groups = uncategorizedGroups([
      stretch(5, { app: "Slack", category: "Communication" }),
      stretch(5, { app: "loginwindow", kind: "idle", category: "Away" }),
      stretch(5, { app: "Microsoft Edge", kind: "untracked", category: "Untracked" }),
      stretch(5, {}),
    ]);
    expect(groups).toEqual([]);
  });

  it("should list the titles that took the most time and keep the longest stretch as the sample", () => {
    const [group] = uncategorizedGroups([
      stretch(1, { app: "Notes", title: "a" }),
      stretch(4, { app: "Notes", title: "b" }),
      stretch(2, { app: "Notes", title: "c" }),
      stretch(3, { app: "Notes", title: "a" }),
      stretch(1, { app: "Notes", title: "d" }),
    ]);
    expect(group.examples).toEqual(["a", "b", "c"]);
    expect(group.sample.title).toBe("b");
  });

  it("should group browser time without a website by page title, never as the whole browser", () => {
    const calendar = "QbDVision - Calendar - Week of November 1, 2026 - Pinned - Google Chrome - Ryan (qbdvision.com)";
    const pr = "QI-15897 Compare across projects by rsshilli · Pull Request #5701 - Google Chrome - Ryan (qbdvision.com)";
    const timeline = [
      stretch(4, { app: "Google Chrome", url: "about:blank", title: calendar }),
      stretch(2, { app: "Google Chrome", title: pr }),
      stretch(1, { app: "Google Chrome", title: calendar }),
    ];
    const groups = uncategorizedGroups(timeline);
    expect(groups.map(({ field, pattern, ms }) => ({ field, pattern, minutes: ms / 60_000 }))).toEqual([
      { field: "title", pattern: "QbDVision - Calendar - Week of November 1, 2026", minutes: 5 },
      { field: "title", pattern: "QI-15897 Compare across projects by rsshilli · Pull Request #5701", minutes: 2 },
    ]);
    const rule = { field: groups[0].field, pattern: groups[0].pattern, category: "Planning" };
    expect(timeline.map((item) => categorize(item, [rule]))).toEqual(["Planning", UNCATEGORIZED, "Planning"]);
  });

  it("should suggest a rule that sorts every stretch in its group", () => {
    const timeline = [
      stretch(5, { app: "Google Chrome", domain: "linear.app", url: "https://linear.app/x" }),
      stretch(5, { app: "Linear", title: "Inbox" }),
      stretch(5, { app: "WebStorm", project: "qbdvision" }),
    ];
    for (const group of uncategorizedGroups(timeline)) {
      const rule = { field: group.field, pattern: group.pattern, category: "Planning" };
      const members = timeline.filter((item) => item[group.field] === group.pattern);
      expect(members.map((item) => categorize(item, [rule]))).toEqual(members.map(() => "Planning"));
    }
  });
});

describe("knownCategories", () => {
  it("should list each category once, alphabetically", () => {
    expect(
      knownCategories([
        { field: "app", pattern: "Slack", category: "Communication" },
        { field: "app", pattern: "WebStorm", category: "Coding" },
        { field: "domain", pattern: "mail.google.com", category: "Communication" },
      ]),
    ).toEqual(["Coding", "Communication"]);
  });
});
