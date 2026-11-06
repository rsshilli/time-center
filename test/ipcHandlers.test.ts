import { assertBackupSettingsInput, assertMoment, assertPermissionKind, assertRowId } from "../src/main/ipcHandlers";

describe("assertRowId", () => {
  it("should accept a positive whole number and reject anything else from the renderer", () => {
    expect(assertRowId(42)).toBe(42);
    expect(() => assertRowId(0)).toThrow(/Not an id/);
    expect(() => assertRowId(1.5)).toThrow(/Not an id/);
    expect(() => assertRowId("42")).toThrow(/Not an id/);
    expect(() => assertRowId(undefined)).toThrow(/Not an id/);
  });
});

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
