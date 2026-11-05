import { BackupScheduler } from "../../src/main/backup/BackupScheduler";
import type { BackupService } from "../../src/main/backup/BackupService";

describe("BackupScheduler", () => {
  it("should back up when a backup is due and report success", async () => {
    const { service, calls } = fakeService(true);
    const results: unknown[] = [];
    const scheduler = new BackupScheduler(service, (r) => results.push(r));

    expect(await scheduler.checkNow()).toBe(true);
    expect(calls()).toBe(1);
    expect(results).toEqual([{ ok: true }]);
  });

  it("should do nothing when no backup is due", async () => {
    const { service, calls } = fakeService(false);
    const scheduler = new BackupScheduler(service, () => undefined);
    expect(await scheduler.checkNow()).toBe(false);
    expect(calls()).toBe(0);
  });

  it("should report a failure instead of throwing", async () => {
    const { service } = fakeService(true, "NoSuchBucket");
    const results: unknown[] = [];
    const scheduler = new BackupScheduler(service, (r) => results.push(r));
    await scheduler.checkNow();
    expect(results).toEqual([{ ok: false, error: "NoSuchBucket" }]);
  });

  it("should not start a second backup while one is running", async () => {
    const { service, calls } = fakeService(true);
    const scheduler = new BackupScheduler(service, () => undefined);
    await Promise.all([scheduler.runNow(), scheduler.runNow()]);
    expect(calls()).toBe(1);
  });

  it("should make a second Back up now wait for the backup already running", async () => {
    let finishBackup: () => void = () => undefined;
    const service = {
      isBackupDue: () => true,
      runBackup: () =>
        new Promise((resolve) => {
          finishBackup = () => resolve({ objectKey: "k", bytes: 1 });
        }),
    } as unknown as BackupService;
    const scheduler = new BackupScheduler(service, () => undefined);

    void scheduler.runNow();
    let secondSettled = false;
    const second = scheduler.runNow().then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(scheduler.isRunning()).toBe(true);
    expect(secondSettled).toBe(false);

    finishBackup();
    await second;
    await scheduler.whenIdle();
    expect(scheduler.isRunning()).toBe(false);
  });
});

/**
 * Builds a fake backup service whose due-ness and outcome the test controls.
 * @param due What isBackupDue answers.
 * @param fail When set, runBackup rejects with this message.
 * @returns The fake and a counter of runBackup calls.
 */
function fakeService(due: boolean, fail?: string): { service: BackupService; calls: () => number } {
  let count = 0;
  const service = {
    isBackupDue: () => due,
    runBackup: async () => {
      count++;
      if (fail) {
        throw new Error(fail);
      }
      return { objectKey: "k", bytes: 1 };
    },
  } as unknown as BackupService;
  return { service, calls: () => count };
}
