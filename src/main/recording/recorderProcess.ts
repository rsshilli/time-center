import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** A piece of one side of the call, written at a pause, waiting for whisper. */
export interface AudioChunk {
  /** The WAV file. */
  wav: string;
  side: "me" | "them";
  /** When its first sample was heard, in milliseconds since 1970. */
  t0: number;
}

/** What the recorder reports while it runs. */
export interface RecorderEvents {
  /** Recording began; mic is false when macOS refused the microphone. */
  onReady(mic: boolean): void;
  onChunk(chunk: AudioChunk): void;
  /** It stopped; error says why when it wasn't asked to. */
  onExit(error: string | null): void;
}

/** A running recorder. */
export interface RecorderHandle {
  /** Asks it to finish its files and exit, by closing its stdin. */
  stop(): void;
}

/** One line the recorder printed, read. */
export type RecorderMessage =
  | { kind: "ready"; mic: boolean }
  | { kind: "chunk"; chunk: AudioChunk }
  | { kind: "error"; message: string };

/**
 * Starts the Swift call recorder (native/MeetingRecorder.swift) writing into a folder.
 * @param binaryPath The compiled helper.
 * @param folder Where me.m4a, them.m4a and chunks/ go.
 * @param events Called as it reports.
 * @returns A handle to stop it.
 */
export function startRecorder(binaryPath: string, folder: string, events: RecorderEvents): RecorderHandle {
  const child = spawn(binaryPath, [folder], { stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.on("error", () => {});
  let lastError: string | null = null;
  let exited = false;
  /** Reports the end once, whether it came as a spawn error or an exit. */
  const finish = (error: string | null) => {
    if (!exited) {
      exited = true;
      events.onExit(error);
    }
  };
  child.on("error", (error) => finish(error.message));
  child.on("exit", (code, signal) => {
    finish(code === 0 ? null : (lastError ?? `The recorder stopped (${signal ?? `code ${code}`}).`));
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = parseRecorderLine(line);
    if (message?.kind === "ready") {
      events.onReady(message.mic);
    } else if (message?.kind === "chunk") {
      events.onChunk(message.chunk);
    } else if (message?.kind === "error") {
      lastError = message.message;
    }
  });
  return {
    stop: () => {
      child.stdin.end();
    },
  };
}

/**
 * Mixes a folder's leftover me.m4a / them.m4a into call.m4a with the recorder's `--mix` mode: calls recorded
 * before both sides were mixed, or whose mix failed when the call ended. Does nothing when there are none.
 * @param binaryPath The compiled recorder.
 * @param folder The recording's working folder.
 * @returns Whether a mixed file was written.
 */
export async function mixLeftoverSides(binaryPath: string, folder: string): Promise<boolean> {
  const sides = ["me.m4a", "them.m4a"].filter((name) => existsSync(join(folder, name)));
  if (sides.length === 0 || existsSync(join(folder, "call.m4a"))) {
    return false;
  }
  return new Promise((resolve) => {
    execFile(binaryPath, ["--mix", folder], { timeout: 5 * 60_000 }, (error) => resolve(error === null));
  });
}

/**
 * Reads one line the recorder printed. Anything else (warnings, malformed lines) is dropped.
 * @param line A JSON line.
 * @returns What it said, or null.
 */
export function parseRecorderLine(line: string): RecorderMessage | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (value.ready === true) {
    return { kind: "ready", mic: value.mic !== false };
  }
  if (typeof value.error === "string") {
    return { kind: "error", message: value.error };
  }
  if (
    typeof value.wav === "string" &&
    (value.src === "me" || value.src === "them") &&
    typeof value.t0 === "number" &&
    Number.isFinite(value.t0)
  ) {
    return { kind: "chunk", chunk: { wav: value.wav, side: value.src, t0: value.t0 } };
  }
  return null;
}

/**
 * Reads the side and start time back from a chunk's file name ("me-1794008490283-1.wav"), for chunks left
 * over from a run that quit before whisper got to them.
 * @param wav The file's path.
 * @returns The chunk, or null for any other file.
 */
export function chunkFromFileName(wav: string): AudioChunk | null {
  const match = /(?:^|\/)(me|them)-(\d+)-\d+\.wav$/.exec(wav);
  if (!match) {
    return null;
  }
  return { wav, side: match[1] as "me" | "them", t0: Number(match[2]) };
}
