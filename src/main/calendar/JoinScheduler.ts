import type { JoinMode, MeetingInfo, MeetingState } from "../../shared/ipc";
import type { CalendarStore } from "./CalendarStore";
import { shouldJoin, type CalendarEvent } from "./meetingLinks";

/** A meeting is joined this long before it starts (the plan's "start − 30 s"). */
export const JOIN_BEFORE_START_MS = 30_000;

/** The "Joining … in 30 s, click to skip" notice goes up this long before the join. */
export const NOTICE_BEFORE_JOIN_MS = 30_000;

/** A meeting found after its start (app opened late, Mac woke late) is still joined up to this far in. */
export const LATE_JOIN_LIMIT_MS = 5 * 60_000;

/** A link joined within this long isn't opened again for a moved or re-created meeting. */
export const REJOIN_GUARD_MS = 3 * 60 * 60_000;

/** Meetings starting this close together count as double-booked; only one is joined. */
export const DOUBLE_BOOKED_MS = 60_000;

/** How often the clock is checked. A tick reads a handful of rows, so once a second costs nothing. */
export const TICK_MS = 1_000;

/** How far ahead the meeting list on Settings and in the tray looks. */
export const LIST_AHEAD_MS = 24 * 60 * 60_000;

/** A notice on screen that can be taken down. */
export interface Notice {
  close(): void;
}

/** What the scheduler needs, injected so tests run without Electron, Chrome or a real clock. */
export interface JoinSchedulerDeps {
  calendar: Pick<CalendarStore, "listEvents" | "getEvent" | "recordJoin" | "getJoin" | "wasJoinedSince">;
  /** Join automatically, only announce the meeting, or do nothing. */
  joinMode(): JoinMode;
  /** Shows "Joining <title> in 30 s — click to skip"; clicking it calls onSkip. */
  notify(event: CalendarEvent, joinAt: number, onSkip: () => void): Notice;
  /** Shows "<title> is starting — click to join"; clicking it calls onJoin. */
  remind(event: CalendarEvent, onJoin: () => void): Notice;
  /** Opens the meeting in Zoom or Chrome. */
  join(event: CalendarEvent): Promise<void>;
  /** Tells the user a join didn't work. */
  reportFailure(event: CalendarEvent, error: string): void;
  /** Called whenever a meeting's state changes, so the tray and Settings can refresh. */
  onChange(): void;
  now(): number;
}

/** A meeting whose notice is up, waiting for its join time. */
interface Plan {
  event: CalendarEvent;
  joinAt: number;
  notice: Notice;
  joining: boolean;
}

/**
 * Joins meetings on time. Each second it looks at the stored meetings: one minute before a meeting starts
 * it puts up a notice you can click to skip, and 30 seconds before the start it opens the meeting. A
 * meeting found late (app just opened, Mac just woke) gets the same 30-second notice and is joined up to
 * five minutes after its start; later than that it is left alone. Each occurrence is decided once —
 * joined, skipped or failed — and the decision is stored, so a restart never joins it twice.
 *
 * When the mode is "notify", nothing is opened: at the join time a notice says the meeting is starting,
 * and clicking it joins. Which reminders were shown is kept only in memory, since the stored decisions
 * are joined/skipped/failed; a restart in a meeting's first five minutes shows its reminder again.
 */
export class JoinScheduler {
  private readonly plans = new Map<string, Plan>();
  /** Click-to-join notices shown in "notify" mode, kept so they can be clicked and taken down. */
  private readonly reminders = new Map<string, { event: CalendarEvent; notice: Notice }>();
  private timer: NodeJS.Timeout | null = null;

  /** @param deps The meetings, the notice, the joiner and the clock. */
  constructor(private readonly deps: JoinSchedulerDeps) {}

  /** Starts checking the clock. */
  start(): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  /** Stops checking and takes down any notice. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const plan of this.plans.values()) {
      plan.notice.close();
    }
    this.plans.clear();
    for (const reminder of this.reminders.values()) {
      reminder.notice.close();
    }
    this.reminders.clear();
  }

  /** Puts up notices and joins meetings that are due. Called every second, and after each sync. */
  tick(): void {
    const now = this.deps.now();
    const mode = this.deps.joinMode();
    const due = new Set<string>();
    // A tick past the notice moment, since listEvents wants meetings starting strictly before its end.
    const lookAhead = JOIN_BEFORE_START_MS + NOTICE_BEFORE_JOIN_MS + TICK_MS;
    for (const event of this.deps.calendar.listEvents(now - LATE_JOIN_LIMIT_MS, now + lookAhead)) {
      if (mode === "off" || !shouldJoin(event) || this.deps.calendar.getJoin(event.eventId, event.start)) {
        continue;
      }
      const tooLate = now > event.start + LATE_JOIN_LIMIT_MS || now >= event.end;
      if (tooLate) {
        continue;
      }
      if (mode === "notify") {
        this.remindIfDue(event, now);
        continue;
      }
      const key = planKey(event);
      // A meeting already announced in "notify" mode isn't opened if the mode is switched to "join".
      if (this.reminders.has(key) || now < event.start - JOIN_BEFORE_START_MS - NOTICE_BEFORE_JOIN_MS) {
        continue;
      }
      if (!this.plans.has(key) && this.alreadyHandled(event, now)) {
        continue;
      }
      due.add(key);
      const plan = this.plans.get(key) ?? this.putUpNotice(event, now);
      if (now >= plan.joinAt && !plan.joining) {
        void this.joinPlanned(plan);
      }
    }
    this.dropStalePlans(due);
    this.dropEndedReminders(now);
  }

  /**
   * In "notify" mode, shows a meeting's click-to-join notice once its join time has come.
   * @param event The meeting, still undecided and not too late to join.
   * @param now The current time.
   */
  private remindIfDue(event: CalendarEvent, now: number): void {
    const key = planKey(event);
    if (this.reminders.has(key) || now < event.start - JOIN_BEFORE_START_MS || this.alreadyHandled(event, now)) {
      return;
    }
    const notice = this.deps.remind(event, () => {
      this.joinNow(event.eventId).catch((error: unknown) => {
        this.deps.reportFailure(event, error instanceof Error ? error.message : String(error));
      });
    });
    this.reminders.set(key, { event, notice });
    this.deps.onChange();
  }

  /**
   * Settles a due meeting that must not be opened again: its link was joined in the last few hours (the
   * organizer moved it after you joined, or it got a new id), or another meeting is being joined at the
   * same moment (double-booked — the first one listed wins; the other can still be joined by hand).
   * @param event The meeting.
   * @param now The current time.
   * @returns True when it was settled here and needs no notice.
   */
  private alreadyHandled(event: CalendarEvent, now: number): boolean {
    if (event.joinUrl && this.deps.calendar.wasJoinedSince(event.joinUrl, now - REJOIN_GUARD_MS)) {
      this.deps.calendar.recordJoin(event.eventId, event.start, "joined", now, null, event.joinUrl);
      this.deps.onChange();
      return true;
    }
    const clash = [...this.plans.values()].find(
      (plan) => plan.event.eventId !== event.eventId && Math.abs(plan.event.start - event.start) < DOUBLE_BOOKED_MS,
    );
    if (clash) {
      const reason = `Double-booked with ${clash.event.title}, which was joined instead.`;
      this.deps.calendar.recordJoin(event.eventId, event.start, "skipped", now, reason, event.joinUrl);
      this.deps.onChange();
      return true;
    }
    return false;
  }

  /**
   * Skips a meeting's coming join, if it hasn't been decided yet.
   * @param eventId The meeting.
   */
  skip(eventId: string): void {
    const event = this.deps.calendar.getEvent(eventId);
    if (!event) {
      return;
    }
    const plan = this.plans.get(planKey(event));
    if (plan?.joining) {
      return;
    }
    plan?.notice.close();
    this.plans.delete(planKey(event));
    this.deps.calendar.recordJoin(event.eventId, event.start, "skipped", this.deps.now(), null, event.joinUrl);
    this.deps.onChange();
  }

  /**
   * Joins a meeting straight away, whatever the setting or your answer to the invitation says, because
   * you asked. Its coming automatic join, if any, is then counted as done.
   * @param eventId The meeting.
   */
  async joinNow(eventId: string): Promise<void> {
    const event = this.deps.calendar.getEvent(eventId);
    if (!event?.joinUrl) {
      throw new Error("That meeting has no link to join.");
    }
    const key = planKey(event);
    const plan = this.plans.get(key);
    if (plan?.joining) {
      return;
    }
    plan?.notice.close();
    // Held while the browser opens, so the next tick neither puts the notice back up nor joins again.
    this.plans.set(key, { event, joinAt: this.deps.now(), joining: true, notice: { close: () => {} } });
    try {
      await this.deps.join(event);
      this.deps.calendar.recordJoin(event.eventId, event.start, "joined", this.deps.now(), null, event.joinUrl);
    } finally {
      this.plans.delete(key);
      this.deps.onChange();
    }
  }

  /**
   * Lists the meetings from now to a day ahead with where each stands.
   * @returns The meetings, soonest first.
   */
  meetings(): MeetingInfo[] {
    const now = this.deps.now();
    const mode = this.deps.joinMode();
    return this.deps.calendar.listEvents(now, now + LIST_AHEAD_MS).map((event) => {
      const plan = this.plans.get(planKey(event));
      const state = plan ? "joining" : this.stateOf(event, now, mode);
      const willAct = state === "will-join" || state === "will-notify";
      return {
        eventId: event.eventId,
        title: event.title,
        start: event.start,
        end: event.end,
        provider: event.provider,
        state,
        joinAt: plan ? plan.joinAt : willAct ? event.start - JOIN_BEFORE_START_MS : null,
      };
    });
  }

  /**
   * Shows the notice for a meeting that's coming up and plans its join.
   * @param event The meeting.
   * @param now The current time.
   * @returns The plan.
   */
  private putUpNotice(event: CalendarEvent, now: number): Plan {
    const joinAt = Math.max(event.start - JOIN_BEFORE_START_MS, now + NOTICE_BEFORE_JOIN_MS);
    const plan: Plan = {
      event,
      joinAt,
      joining: false,
      notice: this.deps.notify(event, joinAt, () => this.skip(event.eventId)),
    };
    this.plans.set(planKey(event), plan);
    this.deps.onChange();
    return plan;
  }

  /**
   * Joins a planned meeting and records how it went.
   * @param plan The plan.
   */
  private async joinPlanned(plan: Plan): Promise<void> {
    plan.joining = true;
    const { event } = plan;
    try {
      await this.deps.join(event);
      this.deps.calendar.recordJoin(event.eventId, event.start, "joined", this.deps.now(), null, event.joinUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.calendar.recordJoin(event.eventId, event.start, "failed", this.deps.now(), message, event.joinUrl);
      this.deps.reportFailure(event, message);
    } finally {
      plan.notice.close();
      this.plans.delete(planKey(event));
      this.deps.onChange();
    }
  }

  /**
   * Takes down notices for meetings no longer due: moved, cancelled, declined, the setting turned off, or
   * the Mac slept past the join window.
   * @param due The keys of meetings still due this tick.
   */
  private dropStalePlans(due: Set<string>): void {
    let changed = false;
    for (const [key, plan] of this.plans) {
      if (!due.has(key) && !plan.joining) {
        plan.notice.close();
        this.plans.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.deps.onChange();
    }
  }

  /**
   * Takes down click-to-join notices for meetings that have ended, since there's nothing left to join.
   * @param now The current time.
   */
  private dropEndedReminders(now: number): void {
    for (const [key, reminder] of this.reminders) {
      if (reminder.event.end <= now) {
        reminder.notice.close();
        this.reminders.delete(key);
      }
    }
  }

  /**
   * Works out where a meeting with no notice up stands.
   * @param event The meeting.
   * @param now The current time.
   * @param mode Join automatically, announce only, or do nothing.
   * @returns Its state.
   */
  private stateOf(event: CalendarEvent, now: number, mode: JoinMode): MeetingState {
    const decided = this.deps.calendar.getJoin(event.eventId, event.start);
    if (decided) {
      return decided;
    }
    if (this.reminders.has(planKey(event))) {
      return "notified";
    }
    if (!event.joinUrl) {
      return "no-link";
    }
    if (!shouldJoin(event)) {
      return "declined";
    }
    if (mode === "off") {
      return "auto-join-off";
    }
    if (now > event.start + LATE_JOIN_LIMIT_MS) {
      return "missed";
    }
    return mode === "notify" ? "will-notify" : "will-join";
  }
}

/**
 * Names one occurrence of a meeting; a moved meeting gets a new name and so a new decision.
 * @param event The meeting.
 * @returns e.g. "abc123@1762354800000".
 */
function planKey(event: CalendarEvent): string {
  return `${event.eventId}@${event.start}`;
}
