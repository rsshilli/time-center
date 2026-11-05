import { execFile } from "node:child_process";
import { cpus } from "node:os";
import type { DisplayCapture } from "./ScreenCapturer";

/** A capture of every display normally takes under a second; past this it is given up. */
const CAPTURE_TIMEOUT_MS = 20_000;

/** Room for every display's JPEG and thumbnail as base64 (about 0.5 MB per display). */
const CAPTURE_MAX_BYTES = 64 * 1024 * 1024;

/** How long the CPU is watched for one reading. */
const CPU_WINDOW_MS = 1_000;

/**
 * Captures every display through the Swift helper (ScreenCaptureKit), with the ignored apps' windows
 * left out of the picture, so the screen you are working on is captured even when an Edge window is
 * also on it.
 * @param binaryPath The compiled helper.
 * @param ignored Apps cut out of the pictures: bundle ids (covering the ids under them) or app names.
 * @returns One JPEG and thumbnail per display, at the display's size in points.
 */
export function captureDisplays(binaryPath: string, ignored: readonly string[]): Promise<DisplayCapture[]> {
  return new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      ["--capture", "--ignore", ignored.join(",")],
      { timeout: CAPTURE_TIMEOUT_MS, maxBuffer: CAPTURE_MAX_BYTES },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`The screenshot helper failed: ${stderr.trim() || error.message}`));
          return;
        }
        try {
          resolve(parseCaptures(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

/**
 * Reads the helper's `--capture` output.
 * @param output A JSON array of { displayId, full, thumb }, the pictures as base64.
 * @returns The decoded pictures.
 */
export function parseCaptures(output: string): DisplayCapture[] {
  const value: unknown = JSON.parse(output);
  if (!Array.isArray(value)) {
    throw new Error("The screenshot helper's answer wasn't a list.");
  }
  return value.map((entry: Record<string, unknown>) => {
    if (typeof entry?.displayId !== "string" || typeof entry.full !== "string" || typeof entry.thumb !== "string") {
      throw new Error("The screenshot helper's answer is missing a display id or picture.");
    }
    return {
      displayId: entry.displayId,
      full: Buffer.from(entry.full, "base64"),
      thumb: Buffer.from(entry.thumb, "base64"),
    };
  });
}

/**
 * Measures total CPU use across all cores over one second.
 * @returns A percentage from 0 to 100.
 */
export async function sampleCpuPercent(): Promise<number> {
  const before = cpuTimes();
  await new Promise((resolve) => setTimeout(resolve, CPU_WINDOW_MS));
  const after = cpuTimes();
  const total = after.total - before.total;
  return total > 0 ? (100 * (total - (after.idle - before.idle))) / total : 0;
}

/**
 * Adds up every core's time counters.
 * @returns Total and idle milliseconds since boot.
 */
function cpuTimes(): { total: number; idle: number } {
  let total = 0;
  let idle = 0;
  for (const cpu of cpus()) {
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
    idle += cpu.times.idle;
  }
  return { total, idle };
}
