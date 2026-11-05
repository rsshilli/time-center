import { SecretStore, type Encryptor } from "../../src/main/store/SecretStore";
import { Store } from "../../src/main/store/Store";

describe("SecretStore", () => {
  it("should round-trip a secret without storing the plain text", () => {
    const store = new Store(":memory:");
    const secrets = new SecretStore(store, fakeEncryptor());
    secrets.set("jira.apiToken", "hunter2-token");

    expect(secrets.get("jira.apiToken")).toBe("hunter2-token");
    const raw = store.getSetting("secret:jira.apiToken") ?? "";
    expect(Buffer.from(raw, "base64").toString("utf8")).not.toContain("hunter2");
  });

  it("should return null for a secret that was never saved, and delete on null", () => {
    const secrets = new SecretStore(new Store(":memory:"), fakeEncryptor());
    expect(secrets.get("nope")).toBeNull();
    secrets.set("x", "y");
    secrets.set("x", null);
    expect(secrets.get("x")).toBeNull();
  });

  it("should refuse to save when secure storage is unavailable", () => {
    const store = new Store(":memory:");
    const secrets = new SecretStore(store, fakeEncryptor(false));
    expect(() => secrets.set("x", "y")).toThrow(/unavailable/);
    expect(store.getSetting("secret:x")).toBeNull();
  });
});

/**
 * Builds a reversible fake encryptor that visibly changes the bytes, so a test can tell encrypted from plain.
 * @param available What isEncryptionAvailable should answer.
 * @returns The fake.
 */
function fakeEncryptor(available = true): Encryptor {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(plain, "utf8").reverse(),
    decryptString: (encrypted) => Buffer.from(encrypted).reverse().toString("utf8"),
  };
}
