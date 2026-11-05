import type { BackupService } from "../src/main/backup/BackupService";
import { describeBackup } from "../src/main/TrayController";

describe("describeBackup", () => {
  it("should say backup is not set up when no bucket is configured", () => {
    expect(describeBackup(fakeService(false, null), null)).toBe("Backup: not set up");
  });

  it("should show the latest error, cut short to fit the menu", () => {
    const line = describeBackup(fakeService(true, null), "x".repeat(200));
    expect(line).toBe(`Backup failed: ${"x".repeat(60)}`);
  });

  it("should say never before the first successful backup", () => {
    expect(describeBackup(fakeService(true, null), null)).toBe("Last backup: never");
  });

  it("should show when the last backup succeeded", () => {
    const line = describeBackup(fakeService(true, "2026-11-04T18:00:00Z"), null);
    expect(line).toMatch(/^Last backup: Nov 4/);
  });
});

/**
 * Builds a fake backup service for the menu line.
 * @param configured Whether a bucket is set.
 * @param lastSuccessAt When the last backup succeeded, or null.
 * @returns The fake.
 */
function fakeService(configured: boolean, lastSuccessAt: string | null): BackupService {
  return {
    getSettings: () => (configured ? { bucket: "b", region: "r", profile: "p", kmsKeyId: null } : null),
    getLastSuccessAt: () => lastSuccessAt,
  } as unknown as BackupService;
}
