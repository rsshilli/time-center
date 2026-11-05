import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { WindowSample } from "./SegmentRecorder";

/** A running helper. */
export interface WindowHelper {
  /** Stops it by closing its stdin, which it exits on. */
  stop(): void;
}

/**
 * Starts the Swift front-window helper (native/ActiveWindow.swift) and passes on each sample it prints.
 * @param binaryPath The compiled helper.
 * @param intervalSeconds How often it reports.
 * @param ignored Apps never read: bundle ids (covering the ids under them) or app names.
 * @param onSample Called with each sample.
 * @param onExit Called once when it stops, for any reason.
 * @returns A handle to stop it.
 */
export function startWindowHelper(
  binaryPath: string,
  intervalSeconds: number,
  ignored: readonly string[],
  onSample: (sample: WindowSample) => void,
  onExit: (reason: string) => void,
): WindowHelper {
  const child = spawn(binaryPath, ["--interval", String(intervalSeconds), "--ignore", ignored.join(",")], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  // Closing stdin of a helper that already died raises EPIPE here; its exit is reported below anyway.
  child.stdin.on("error", () => {});
  let exited = false;
  /** Reports the end once, whether it came as an error or an exit. */
  const finish = (reason: string) => {
    if (!exited) {
      exited = true;
      onExit(reason);
    }
  };
  child.on("error", (error) => finish(error.message));
  child.on("exit", (code, signal) => finish(`exited with ${signal ?? `code ${code}`}`));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const sample = parseSample(line);
    if (sample) {
      onSample(sample);
    }
  });
  return {
    stop: () => {
      child.stdin.end();
    },
  };
}

/**
 * Reads one line the helper printed. Anything malformed is dropped.
 * @param line A JSON line.
 * @returns The sample, or null.
 */
export function parseSample(line: string): WindowSample | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    return {
      app: stringOrNull(value.app),
      bundleId: stringOrNull(value.bundleId),
      title: stringOrNull(value.title),
      url: stringOrNull(value.url),
      ignored: value.ignored === true,
    };
  } catch {
    return null;
  }
}

/**
 * Keeps a value only if it is non-empty text.
 * @param value The value.
 * @returns The text, or null.
 */
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
