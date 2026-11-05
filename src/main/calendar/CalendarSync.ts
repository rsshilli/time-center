import { localDayBounds } from "../activity/dayReport";
import type { CalendarClient } from "./CalendarClient";
import type { CalendarStore } from "./CalendarStore";
import { toCalendarEvent, type CalendarEvent } from "./meetingLinks";

/** How often the calendar is read again (the plan's "refresh every 5 min"). */
export const SYNC_EVERY_MS = 5 * 60_000;

/** The window each read covers: from an hour back, so a meeting in progress stays listed, to a day ahead. */
export const SYNC_BACK_MS = 60 * 60_000;
export const SYNC_AHEAD_MS = 24 * 60 * 60_000;

/** The setting that remembers the calendar's account, shown in Settings and used to pick Meet's account. */
export const GOOGLE_ACCOUNT_SETTING = "googleAccount";

/** What a sync needs, injected for tests. */
export interface CalendarSyncDeps {
  client: Pick<CalendarClient, "listEvents" | "getAccount">;
  calendar: Pick<CalendarStore, "replaceEvents">;
  settings: { getSetting(key: string): string | null; setSetting(key: string, value: string | null): void };
  isSignedIn(): boolean;
  /** Called after each sync that stored meetings, so joins due soon are planned straight away. */
  onSynced(): void;
  now(): number;
}

/**
 * Copies the main Google calendar's coming meetings into the database every five minutes. When the
 * network is down the last copy stays in place, so meetings already known are still joined on time.
 */
export class CalendarSync {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private lastSyncAt: number | null = null;
  private lastError: string | null = null;

  /** @param deps The Google client, the tables and the clock. */
  constructor(private readonly deps: CalendarSyncDeps) {}

  /** Syncs now and then every five minutes. */
  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.syncNow(), SYNC_EVERY_MS);
    void this.syncNow();
  }

  /** Stops the five-minute sync. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Reads the calendar now, or waits for the read already under way. Never throws: a failure is kept for
   * Settings to show.
   * @returns When the read has finished.
   */
  syncNow(): Promise<void> {
    this.running ??= this.sync().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** @returns When the last read worked and the last error, for Settings. */
  status(): { lastSyncAt: number | null; lastError: string | null } {
    return { lastSyncAt: this.lastSyncAt, lastError: this.lastError };
  }

  /** @returns The calendar's Google account, once a sync has learned it. */
  account(): string | null {
    return this.deps.settings.getSetting(GOOGLE_ACCOUNT_SETTING);
  }

  /** Forgets the account and the last result, after a sign-out. */
  reset(): void {
    this.deps.settings.setSetting(GOOGLE_ACCOUNT_SETTING, null);
    this.lastSyncAt = null;
    this.lastError = null;
  }

  /** Reads the calendar window and stores its meetings. */
  private async sync(): Promise<void> {
    if (!this.deps.isSignedIn()) {
      return;
    }
    const now = this.deps.now();
    // From local midnight at the latest, so today's earlier meetings carry their attendees for sorting.
    const from = Math.min(now - SYNC_BACK_MS, localDayBounds(now).dayStart);
    const to = now + SYNC_AHEAD_MS;
    try {
      if (!this.account()) {
        this.deps.settings.setSetting(GOOGLE_ACCOUNT_SETTING, await this.deps.client.getAccount());
      }
      const events = (await this.deps.client.listEvents(from, to))
        .map(toCalendarEvent)
        .filter((event): event is CalendarEvent => event !== null);
      this.deps.calendar.replaceEvents(from, to, events, now);
      this.lastSyncAt = now;
      this.lastError = null;
      this.deps.onSynced();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error("Time Center: calendar sync failed", error);
    }
  }
}
