import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Copies the Chrome companion extension (its manifest and built script) to a folder that never moves, so
 * Chrome's "Load unpacked" keeps working after the app is rebuilt or moved, and writes `build/key.js`
 * with the key the extension checks join markers against. Called at every launch, which also brings
 * Chrome's copy up to date (Chrome picks the change up when it restarts or on Reload).
 * @param source The extension folder shipped with the app.
 * @param destination The fixed folder Chrome loads.
 * @param keyHex The key shared with the app (the same every launch).
 */
export async function installExtensionCopy(source: string, destination: string, keyHex: string): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await mkdir(join(destination, "build"), { recursive: true, mode: 0o700 });
  await cp(join(source, "manifest.json"), join(destination, "manifest.json"));
  await cp(join(source, "build", "join.js"), join(destination, "build", "join.js"));
  const keyPath = join(destination, "build", "key.js");
  // Content scripts share one private world per extension, so join.js reads this; web pages can't.
  await writeFile(keyPath, `self.timeCenterKey = ${JSON.stringify(keyHex)};\n`, { mode: 0o600 });
  await chmod(keyPath, 0o600);
}
