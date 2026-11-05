import { assertBackupSettingsInput, assertMoment, assertPermissionKind } from "../src/main/ipcHandlers";

describe("assertMoment", () => {
  it("should accept a time in milliseconds and reject anything else from the renderer", () => {
    expect(assertMoment(1_762_000_000_000)).toBe(1_762_000_000_000);
    expect(() => assertMoment("today")).toThrow(/Not a moment/);
    expect(() => assertMoment(Number.NaN)).toThrow(/Not a moment/);
    expect(() => assertMoment(1e20)).toThrow(/Not a moment/);
  });
});

describe("assertPermissionKind", () => {
  it("should accept the four permission names and reject anything else from the renderer", () => {
    expect(assertPermissionKind("screen")).toBe("screen");
    expect(() => assertPermissionKind("camera")).toThrow(/Unknown permission/);
    expect(() => assertPermissionKind({ kind: "screen" })).toThrow(/Unknown permission/);
    expect(() => assertPermissionKind(undefined)).toThrow(/Unknown permission/);
  });
});

describe("assertBackupSettingsInput", () => {
  it("should accept four text fields and drop anything extra", () => {
    const input = { bucket: "b", region: "r", profile: "p", kmsKeyId: "", extra: "ignored" };
    expect(assertBackupSettingsInput(input)).toEqual({ bucket: "b", region: "r", profile: "p", kmsKeyId: "" });
  });

  it("should reject a missing field, a non-text field, or no object at all", () => {
    expect(() => assertBackupSettingsInput({ bucket: "b", region: "r", profile: "p" })).toThrow(/kmsKeyId/);
    expect(() => assertBackupSettingsInput({ bucket: 1, region: "r", profile: "p", kmsKeyId: "" })).toThrow();
    expect(() => assertBackupSettingsInput(null)).toThrow();
    expect(() => assertBackupSettingsInput("bucket")).toThrow();
  });
});
