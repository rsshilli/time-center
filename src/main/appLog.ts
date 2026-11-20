import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** How big the log grows before it's moved aside to `<file>.1` and a new one started. */
export const MAX_LOG_BYTES = 1_000_000;

/** The longest single entry kept; a page's error can carry a whole stack. */
export const MAX_ENTRY_CHARS = 4_000;

/**
 * A small file of things that went wrong while nobody was watching: a window's page or a helper process dying,
 * an error on a page, a screen showing fewer TODOs than it holds. It never throws, since it's only ever written
 * to on the way past a problem.
 */
export class AppLog {
  /**
   * @param path The log file, e.g. ~/Library/Logs/Time Center/app.log.
   * @param now The clock.
   */
  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Adds one line: when, where from, and what.
   * @param source Where it came from, e.g. "window" or "todos".
   * @param message What happened.
   */
  write(source: string, message: string): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      this.rollIfFull();
      const text = message.replace(/\s+/g, " ").trim().slice(0, MAX_ENTRY_CHARS);
      appendFileSync(this.path, `${new Date(this.now()).toISOString()} [${source}] ${text}\n`);
    } catch (failure) {
      console.error("Time Center: couldn't write the app log", failure);
    }
  }

  /** Moves a full log aside, keeping one older file. */
  private rollIfFull(): void {
    try {
      if (statSync(this.path).size >= MAX_LOG_BYTES) {
        renameSync(this.path, `${this.path}.1`);
      }
    } catch {
      // No log yet: nothing to roll.
    }
  }
}

/**
 * Checks a problem the page reports before it's written: plain text, a known source, not too long.
 * @param source Where on the page it came from.
 * @param message What happened.
 * @returns The two, tidied.
 */
export function assertPageProblem(source: unknown, message: unknown): { source: string; message: string } {
  if (typeof source !== "string" || !/^[a-z-]{1,20}$/.test(source)) {
    throw new Error("Say which part of the page it came from.");
  }
  if (typeof message !== "string" || message.trim() === "") {
    throw new Error("Say what went wrong.");
  }
  return { source: `page:${source}`, message: message.slice(0, MAX_ENTRY_CHARS) };
}
