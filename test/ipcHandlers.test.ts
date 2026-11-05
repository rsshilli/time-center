import { assertBackupSettingsInput, assertPermissionKind } from "../src/main/ipcHandlers";

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
