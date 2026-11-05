import type { Store } from "./Store";

/** The encryption half of Electron's `safeStorage`, injected so tests can run without Electron. */
export interface Encryptor {
  /** Whether the Keychain-held key can be used right now. */
  isEncryptionAvailable(): boolean;
  /** Encrypts text with the Keychain-held key. */
  encryptString(plainText: string): Buffer;
  /** Decrypts what encryptString produced. */
  decryptString(encrypted: Buffer): string;
}

/**
 * Keeps secrets (API tokens, OAuth refresh tokens) in the settings table, encrypted with a key held in the
 * macOS Keychain via Electron's `safeStorage`. The plain text never touches the disk.
 */
export class SecretStore {
  /**
   * @param store The database that holds the encrypted values.
   * @param encryptor Electron's `safeStorage`, or a stand-in for tests.
   */
  constructor(
    private readonly store: Store,
    private readonly encryptor: Encryptor,
  ) {}

  /**
   * Encrypts and saves a secret, or removes it when the value is null.
   * @param name The secret's name, e.g. "jira.apiToken".
   * @param value The plain-text secret, or null to delete it.
   */
  set(name: string, value: string | null): void {
    if (value === null) {
      this.store.setSetting(this.keyFor(name), null);
      return;
    }
    this.assertAvailable();
    this.store.setSetting(this.keyFor(name), this.encryptor.encryptString(value).toString("base64"));
  }

  /**
   * Reads and decrypts a secret.
   * @param name The secret's name.
   * @returns The plain text, or null when it was never saved.
   */
  get(name: string): string | null {
    const stored = this.store.getSetting(this.keyFor(name));
    if (stored === null) {
      return null;
    }
    this.assertAvailable();
    return this.encryptor.decryptString(Buffer.from(stored, "base64"));
  }

  /**
   * Maps a secret name to its settings key, keeping secrets apart from ordinary settings.
   * @param name The secret's name.
   * @returns The settings key.
   */
  private keyFor(name: string): string {
    return `secret:${name}`;
  }

  /** Refuses to work when the Keychain-backed key is unavailable, rather than storing plain text. */
  private assertAvailable(): void {
    if (!this.encryptor.isEncryptionAvailable()) {
      throw new Error("Secure storage is unavailable, so the secret was not saved or read.");
    }
  }
}
