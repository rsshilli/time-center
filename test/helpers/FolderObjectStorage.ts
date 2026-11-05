import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { ObjectStorage } from "../../src/main/backup/ObjectStorage";

/**
 * A stand-in for S3 that keeps objects as files under a folder, and remembers the KMS key each upload
 * asked for so tests can check encryption was requested.
 */
export class FolderObjectStorage implements ObjectStorage {
  readonly kmsKeysByObject = new Map<string, string | null>();

  /** @param root The folder that plays the bucket. */
  constructor(private readonly root: string) {}

  /** Copies the file in under its key. */
  async put(key: string, filePath: string, kmsKeyId: string | null): Promise<void> {
    const target = join(this.root, key);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(filePath, target);
    this.kmsKeysByObject.set(key, kmsKeyId);
  }

  /** Copies the object out to a file. */
  async get(key: string, filePath: string): Promise<void> {
    await copyFile(join(this.root, key), filePath);
  }

  /** Lists every stored key under a prefix. */
  async list(prefix: string): Promise<string[]> {
    const entries = await readdir(this.root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(this.root, join(entry.parentPath, entry.name)))
      .filter((key) => key.startsWith(prefix));
  }
}
