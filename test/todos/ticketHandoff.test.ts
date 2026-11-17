import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COWORK_URL, type TicketBrief } from "../../src/shared/ipc";
import { type HandoffDependencies, MAX_COWORK_CHARS, QBDCODE_CLI, QBDCODE_PLAN_FIRST } from "../../src/main/todos/handoff";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_SENDS_PER_TICKET,
  MAX_TICKETS_REMEMBERED,
  TICKET_SENDS_KEY,
  readTicketSends,
  recordTicketSends,
  ticketHandoff,
  ticketsHandoffText,
} from "../../src/main/todos/ticketHandoff";

/** A ticket as read from Jira. */
function brief(key: string, description = ""): TicketBrief {
  return { key, summary: `Summary of ${key}`, type: "Bug", status: "In Draft", url: `https://jira.example/browse/${key}`, description };
}

/** A settings table held in a map. */
function fakeSettings() {
  const saved = new Map<string, string>();
  return {
    saved,
    getSetting: (key: string) => saved.get(key) ?? null,
    setSetting: (key: string, value: string | null) => {
      if (value === null) {
        saved.delete(key);
      } else {
        saved.set(key, value);
      }
    },
  };
}

/** Writes a fake qbdvision checkout with one linked worktree on a branch. */
function fakeRepo(home: string, linkedBranch: string): string {
  const repo = join(home, "projects", "qbdvision");
  mkdirSync(join(repo, ".git", "worktrees", "qbdvision2"), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  const folder = join(home, "projects", "qbdvision2");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(repo, ".git", "worktrees", "qbdvision2", "gitdir"), `${join(folder, ".git")}\n`);
  writeFileSync(join(repo, ".git", "worktrees", "qbdvision2", "HEAD"), `ref: refs/heads/${linkedBranch}\n`);
  return folder;
}

describe("ticketHandoff", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tc-tickets-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** The hand-off with fakes: Jira answers from briefs, links and programs are recorded. */
  function setUp(coworkInstalled = true) {
    const opened: string[] = [];
    const handoff: HandoffDependencies = {
      home,
      callTranscript: () => null,
      openExternal: async (url) => {
        opened.push(url);
      },
      run: vi.fn(async () => "Queued a chat\n"),
    };
    const settings = fakeSettings();
    const readTickets = vi.fn(async (keys: string[]) => keys.map((key) => brief(key, `About ${key}`)));
    const api = ticketHandoff({ handoff, readTickets, settings, coworkInstalled: () => coworkInstalled, now: () => 1_000 });
    return { api, opened, settings, readTickets, handoff };
  }

  describe("ticketsHandoffText", () => {
    it("should list each ticket with its number, summary, type, status, link and description", () => {
      expect(ticketsHandoffText([brief("QI-1", "Steps here"), brief("QI-2")])).toBe(
        [
          "Here are 2 Jira tickets from my current sprint. Please help me get them done.",
          "",
          "## QI-1: Summary of QI-1",
          "Bug · In Draft · https://jira.example/browse/QI-1",
          "",
          "Steps here",
          "",
          "## QI-2: Summary of QI-2",
          "Bug · In Draft · https://jira.example/browse/QI-2",
        ].join("\n"),
      );
      expect(ticketsHandoffText([brief("QI-1")])).toMatch(/^Here's a Jira ticket from my current sprint\. Please help me get it done\./);
    });

    it("should cut a long description so the other tickets still fit", () => {
      const text = ticketsHandoffText([brief("QI-1", "x".repeat(MAX_DESCRIPTION_CHARS + 500)), brief("QI-2")]);

      expect(text).toContain(`${"x".repeat(MAX_DESCRIPTION_CHARS)}…`);
      expect(text).toContain("## QI-2");
    });
  });

  describe("sendTicketsToCowork", () => {
    it("should open one Cowork task on all the tickets and remember it against each", async () => {
      const { api, opened, settings } = setUp();

      const sends = await api.sendTicketsToCowork(["QI-1", "QI-2"]);

      expect(opened).toHaveLength(1);
      const text = decodeURIComponent(opened[0].replace("claude://cowork/new?q=", ""));
      expect(text).toContain("## QI-1: Summary of QI-1");
      expect(text).toContain("About QI-2");
      expect(text.length).toBeLessThanOrEqual(MAX_COWORK_CHARS);
      const sent = { action: "cowork", label: "Claude Cowork", url: COWORK_URL, at: 1_000 };
      expect(sends).toEqual({ "QI-1": [sent], "QI-2": [sent] });
      expect(readTicketSends(settings)).toEqual(sends);
    });

    it("should refuse without Claude Desktop, opening and remembering nothing", async () => {
      const { api, opened, settings, readTickets } = setUp(false);

      await expect(api.sendTicketsToCowork(["QI-1"])).rejects.toThrow("Install Claude Desktop first");
      expect(opened).toHaveLength(0);
      expect(readTickets).not.toHaveBeenCalled();
      expect(settings.saved.has(TICKET_SENDS_KEY)).toBe(false);
    });

    it("should remember nothing when QbDCode doesn't queue the chat", async () => {
      const folder = fakeRepo(home, "two");
      mkdirSync(join(home, ".local", "bin"), { recursive: true });
      writeFileSync(join(home, QBDCODE_CLI), "");
      const { api, settings, handoff } = setUp();
      vi.mocked(handoff.run).mockResolvedValueOnce("no such directory\n");

      await expect(api.sendTicketsToQbdcode(["QI-1"], folder, "x")).rejects.toThrow(/didn't open a chat/);
      expect(settings.saved.has(TICKET_SENDS_KEY)).toBe(false);
    });

    it("should refuse keys that aren't tickets without reading Jira or opening anything", async () => {
      const { api, opened, readTickets } = setUp();

      await expect(api.sendTicketsToCowork(["QI-1", "rm -rf"])).rejects.toThrow(/Not a Jira ticket/);
      expect(readTickets).not.toHaveBeenCalled();
      expect(opened).toHaveLength(0);
    });
  });

  describe("getTicketWorktrees", () => {
    it("should list each worktree under every ticket its branch names, the main checkout included", () => {
      const folder = fakeRepo(home, "ryan-QI-2-and-QI-3-Export");
      writeFileSync(join(home, "projects", "qbdvision", ".git", "HEAD"), "ref: refs/heads/ryan-QI-1-Fix\n");
      const { api } = setUp();

      const byTicket = api.getTicketWorktrees();

      expect(byTicket["QI-1"]).toEqual([{ name: "qbdvision", path: join(home, "projects", "qbdvision"), branch: "ryan-QI-1-Fix" }]);
      expect(byTicket["QI-2"]).toEqual([{ name: "qbdvision2", path: folder, branch: "ryan-QI-2-and-QI-3-Export" }]);
      expect(byTicket["QI-3"]).toEqual(byTicket["QI-2"]);
      expect(Object.keys(byTicket)).toHaveLength(3);
    });

    it("should list nothing for branches without a ticket, or without a checkout", () => {
      expect(setUp().api.getTicketWorktrees()).toEqual({});
      fakeRepo(home, "master");
      expect(setUp().api.getTicketWorktrees()).toEqual({});
    });
  });

  describe("prepareTicketsQbdcode", () => {
    it("should start on the worktree already on one of the tickets' branches", async () => {
      const folder = fakeRepo(home, "ryan-QI-2-Export_rows");
      const { api } = setUp();

      const prepared = await api.prepareTicketsQbdcode(["QI-1", "QI-2"]);

      expect(prepared.preferredPath).toBe(folder);
      expect(prepared.worktrees.map((worktree) => worktree.label)).toEqual(["qbdvision (main)", "qbdvision2 (QI-2)"]);
      expect(prepared.text).toContain("## QI-1");
      expect(prepared.text.endsWith(QBDCODE_PLAN_FIRST)).toBe(true);
    });

    it("should leave the pick to the popup when no worktree is on a ticket", async () => {
      fakeRepo(home, "ryan-QI-9-Other");
      const { api } = setUp();

      expect((await api.prepareTicketsQbdcode(["QI-1"])).preferredPath).toBeNull();
    });
  });

  describe("sendTicketsToQbdcode", () => {
    it("should start one chat in the worktree picked and remember it against each ticket", async () => {
      const folder = fakeRepo(home, "two");
      mkdirSync(join(home, ".local", "bin"), { recursive: true });
      writeFileSync(join(home, QBDCODE_CLI), "");
      const { api, handoff } = setUp();

      const sends = await api.sendTicketsToQbdcode(["QI-1", "QI-2"], folder, "Do both");

      expect(handoff.run).toHaveBeenCalledTimes(1);
      expect(handoff.run).toHaveBeenCalledWith("/bin/bash", [join(home, QBDCODE_CLI), "chat", folder, "--prompt", `Do both\n\n${QBDCODE_PLAN_FIRST}`], expect.anything());
      expect(sends["QI-1"]).toEqual([{ action: "qbdcode", label: "QbDCode · qbdvision2", url: null, at: 1_000 }]);
      expect(sends["QI-2"]).toEqual(sends["QI-1"]);
    });

    it("should remember nothing when the chat doesn't start", async () => {
      const folder = fakeRepo(home, "two");
      const { api, settings } = setUp();

      await expect(api.sendTicketsToQbdcode(["QI-1"], folder, "x")).rejects.toThrow(/Install QbDCode first/);
      expect(settings.saved.has(TICKET_SENDS_KEY)).toBe(false);
    });
  });

  describe("recordTicketSends", () => {
    it("should keep only the latest sends per ticket and the most recently sent tickets", () => {
      const settings = fakeSettings();
      let now = 0;
      const deps = { settings, now: () => ++now };
      for (let i = 0; i < MAX_SENDS_PER_TICKET + 2; i++) {
        recordTicketSends(deps, ["QI-1"], { action: "cowork", label: "Claude Cowork", url: COWORK_URL });
      }
      for (let i = 0; i < MAX_TICKETS_REMEMBERED; i++) {
        recordTicketSends(deps, [`QI-${100 + i}`], { action: "cowork", label: "Claude Cowork", url: COWORK_URL });
      }

      const sends = readTicketSends(settings);
      expect(Object.keys(sends)).toHaveLength(MAX_TICKETS_REMEMBERED);
      expect(sends["QI-1"]).toBeUndefined();
      expect(sends[`QI-${100 + MAX_TICKETS_REMEMBERED - 1}`]).toHaveLength(1);
    });

    it("should keep the latest few sends of one ticket", () => {
      const settings = fakeSettings();
      let now = 0;
      for (let i = 0; i < MAX_SENDS_PER_TICKET + 2; i++) {
        recordTicketSends({ settings, now: () => ++now }, ["QI-1"], { action: "qbdcode", label: "QbDCode · x", url: null });
      }

      expect(readTicketSends(settings)["QI-1"].map((sent) => sent.at)).toEqual([3, 4, 5, 6, 7]);
    });

    it("should read an unreadable or odd saved value as nothing sent", () => {
      const settings = fakeSettings();
      settings.saved.set(TICKET_SENDS_KEY, "{not json");
      expect(readTicketSends(settings)).toEqual({});
      settings.saved.set(TICKET_SENDS_KEY, JSON.stringify({ "QI-1": "x", "QI-2": [] }));
      expect(readTicketSends(settings)).toEqual({ "QI-2": [] });
      const good = { action: "cowork", label: "Claude Cowork", url: COWORK_URL, at: 5 };
      settings.saved.set(TICKET_SENDS_KEY, JSON.stringify({ "QI-3": [null, { action: "cowork" }, good] }));
      expect(readTicketSends(settings)).toEqual({ "QI-3": [good] });
    });
  });
});
