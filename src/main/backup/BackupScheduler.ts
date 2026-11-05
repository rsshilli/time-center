import type { BackupService } from "./BackupService";

/** How often the scheduler asks whether a backup is due. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Runs the weekly backup. It checks hourly, at startup and whenever the Mac wakes, and backs up when the
 * last success is a week old. Checking (rather than one fixed weekly timer) means a week missed while
 * the laptop was closed is made up as soon as it is open again.
 */
export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  /**
   * @param service The backup service.
   * @param onResult Told about every attempt, so the tray can show the last-backup date or an error.
   */
  constructor(
    private readonly service: BackupService,
    private readonly onResult: (result: { ok: true } | { ok: false; error: string }) => void,
  ) {}

  /**
   * Says whether a backup is in progress right now.
   * @returns True while a backup is working.
   */
  isRunning(): boolean {
    return this.inFlight !== null;
  }

  /** Starts hourly checks and runs one check straight away. */
  start(): void {
    this.timer = setInterval(() => {
      void this.checkNow();
    }, CHECK_INTERVAL_MS);
    void this.checkNow();
  }

  /** Stops the hourly checks. A backup already in progress carries on. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Backs up if one is due. Ignored while a backup is already in progress.
   * @returns True when a backup was attempted.
   */
  async checkNow(): Promise<boolean> {
    const now = new Date();
    if (this.inFlight || !this.service.isBackupDue(now)) {
      return false;
    }
    await this.runNow(now);
    return true;
  }

  /**
   * Backs up immediately, whether or not one is due (the tray's "Back up now"). If a backup is already
   * in progress, no second one starts; the caller waits for the one that is running.
   * @param now The time to stamp on the backup.
   * @returns Settles when the backup has finished, whatever its outcome.
   */
  runNow(now: Date = new Date()): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.attempt(now).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /**
   * Waits for a backup in progress to finish, so the app can quit without closing the database under it.
   * @returns Settles at once when nothing is running.
   */
  async whenIdle(): Promise<void> {
    await this.inFlight;
  }

  /**
   * Runs one backup and reports the outcome.
   * @param now The time to stamp on the backup.
   */
  private async attempt(now: Date): Promise<void> {
    try {
      await this.service.runBackup(now);
      this.onResult({ ok: true });
    } catch (error) {
      this.onResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
