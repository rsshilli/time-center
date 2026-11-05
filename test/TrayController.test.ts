import type { BackupService } from "../src/main/backup/BackupService";
import type { MeetingInfo } from "../src/shared/ipc";
import { describeBackup, meetingMenuItems } from "../src/main/TrayController";

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

describe("meetingMenuItems", () => {
  const now = Date.parse("2026-11-05T14:00:00Z");

  /**
   * A meeting starting an hour from now.
   * @param state Where it stands.
   * @param extra Anything else to change.
   * @returns The meeting.
   */
  const meeting = (state: MeetingInfo["state"], extra: Partial<MeetingInfo> = {}): MeetingInfo => ({
    eventId: "e1",
    title: "Standup",
    start: now + 3_600_000,
    end: now + 5_400_000,
    provider: "meet",
    state,
    joinAt: null,
    ...extra,
  });

  it("should point to Settings before Google is signed in", () => {
    expect(meetingMenuItems(false, [], now)).toEqual([
      { label: "Meetings: sign in to Google in Settings…", action: { kind: "settings" } },
    ]);
  });

  it("should offer to skip or join the next meeting", () => {
    const items = meetingMenuItems(true, [meeting("will-join")], now);
    expect(items[0].label).toMatch(/^Next: Standup at .+ \(joins automatically\)$/);
    expect(items.slice(1)).toEqual([
      { label: "Skip joining Standup", action: { kind: "skip", eventId: "e1" } },
      { label: "Join Standup now", action: { kind: "join", eventId: "e1" } },
    ]);
  });

  it("should pass over declined and finished meetings", () => {
    const items = meetingMenuItems(
      true,
      [meeting("joined", { end: now - 1 }), meeting("declined", { eventId: "e2" }), meeting("no-link", { eventId: "e3", provider: null })],
      now,
    );
    expect(items).toHaveLength(1);
    expect(items[0].label).toMatch(/\(no meeting link\)$/);
  });

  it("should say when nothing is coming up", () => {
    expect(meetingMenuItems(true, [], now)).toEqual([{ label: "No meetings in the next day", action: null }]);
  });
});
