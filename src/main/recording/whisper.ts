import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { setPriority } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";

/** One stretch whisper heard, in milliseconds from the start of its file. */
export interface WhisperSegment {
  from: number;
  to: number;
  text: string;
}

/** The speech model (user's pick): large-v3-turbo. A 7 s chunk took 3.6 s at nice 15 here (2026-11-06). */
export const MODEL_FILE = "ggml-large-v3-turbo.bin";

/** Where the model is downloaded from when it isn't on the Mac yet (~1.6 GB). */
export const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}`;

/** A downloaded model smaller than this is a broken download or an error page, not the model. */
const MIN_MODEL_BYTES = 1_000_000_000;

/** Words whisper should spell our way; it reads the prompt as earlier speech. */
const PROMPT = "QbDVision, Jira, GitHub, Time Center.";

/** Where Homebrew puts whisper.cpp's command-line tool. A Finder-opened app has no Homebrew PATH. */
const WHISPER_CANDIDATES = ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"];

/** A model download in progress, shared by every caller. */
let downloading: Promise<string> | null = null;

/** whisper-cli processes running now, so quit can end them rather than leave them behind. */
const running = new Set<ChildProcess>();

/** Ends every whisper-cli run in progress; their chunks stay on disk for the next start. */
export function cancelWhisper(): void {
  for (const child of running) {
    child.kill("SIGKILL");
  }
}

/**
 * Finds whisper-cli and the speech model, downloading the model into the app's folder the first time.
 * @param modelsDir The app's models folder.
 * @param wait Whether to wait for a download; false (for dictation, which you're watching) starts it and
 *   says so straight away rather than leaving you waiting through 1.6 GB.
 * @returns Both paths.
 */
export async function prepareWhisper(modelsDir: string, wait = true): Promise<{ whisper: string; model: string }> {
  const whisper = WHISPER_CANDIDATES.find((path) => existsSync(path));
  if (!whisper) {
    throw new Error(
      "whisper.cpp isn't installed, so calls and dictated questions can't be turned into text yet. Install it in Terminal with: brew install whisper-cpp",
    );
  }
  const model = join(modelsDir, MODEL_FILE);
  if (existsSync(model)) {
    return { whisper, model };
  }
  downloading ??= downloadModel(model).finally(() => {
    downloading = null;
  });
  if (!wait) {
    downloading.catch(() => {
      // A failed download is reported by whoever waits for it; the next try starts it again.
    });
    throw new Error("the speech model (1.6 GB) is still downloading. Try again in a few minutes, or type your question.");
  }
  try {
    return { whisper, model: await downloading };
  } catch (error) {
    throw new Error(`Couldn't download the speech model (${error instanceof Error ? error.message : String(error)}); trying again shortly.`);
  }
}

/**
 * Downloads the model to a temporary name, then moves it into place once it's whole.
 * @param model Where it belongs.
 * @returns The path.
 */
async function downloadModel(model: string): Promise<string> {
  await mkdir(dirname(model), { recursive: true });
  const partial = `${model}.part`;
  const response = await fetch(MODEL_URL);
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body as ReadableStream), createWriteStream(partial));
  if ((await stat(partial)).size < MIN_MODEL_BYTES) {
    await rm(partial, { force: true });
    throw new Error("the file was too small");
  }
  await rename(partial, model);
  return model;
}

/**
 * Turns a dictated question into text right away, at normal priority, so you aren't kept waiting behind a
 * call's chunks.
 * @param whisper whisper-cli.
 * @param model The model file.
 * @param audio The speech, a WAV file's bytes.
 * @param dir A folder for the file whisper reads; it is deleted afterwards.
 * @returns The words heard, without whisper's sound tags such as "[BLANK_AUDIO]".
 */
export async function transcribeSpeech(whisper: string, model: string, audio: Uint8Array, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const wav = join(dir, `dictation-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  await writeFile(wav, audio);
  try {
    const segments = await runWhisper(whisper, model, wav, 0);
    return cleanDictation(segments.map((segment) => segment.text).join(" "));
  } finally {
    await rm(wav, { force: true });
  }
}

/**
 * Tidies dictated text: drops whisper's tags for sounds ("[BLANK_AUDIO]", "[Music]") and extra spaces.
 * @param text What whisper heard.
 * @returns The words.
 */
export function cleanDictation(text: string): string {
  return text.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Runs whisper-cli on one WAV, at the lowest CPU priority unless told otherwise, and reads its JSON.
 * @param whisper whisper-cli.
 * @param model The model file.
 * @param wav The audio.
 * @param priority Its nice value: 19 (lowest, for calls) by default, 0 for a question you're waiting on.
 * @returns What it heard.
 */
export async function runWhisper(whisper: string, model: string, wav: string, priority = 19): Promise<WhisperSegment[]> {
  const base = wav.replace(/\.wav$/, "");
  const args = ["-m", model, "-f", wav, "-oj", "-of", base, "-np", "-t", "4", "--prompt", PROMPT];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(whisper, args, { stdio: "ignore" });
    running.add(child);
    child.on("close", () => running.delete(child));
    if (child.pid && priority !== 0) {
      try {
        setPriority(child.pid, priority);
      } catch {
        // It may already have finished; a short chunk takes a second or two.
      }
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`whisper-cli exited with code ${code}`));
      }
    });
  });
  const json = `${base}.json`;
  try {
    return parseWhisperJson(await readFile(json, "utf8"));
  } finally {
    await rm(json, { force: true });
  }
}

/**
 * Reads whisper-cli's `-oj` output.
 * @param text The JSON file's text.
 * @returns Its segments.
 */
export function parseWhisperJson(text: string): WhisperSegment[] {
  const value = JSON.parse(text) as { transcription?: { offsets?: { from?: unknown; to?: unknown }; text?: unknown }[] };
  return (value.transcription ?? [])
    .filter((item) => typeof item.text === "string" && typeof item.offsets?.from === "number" && typeof item.offsets?.to === "number")
    .map((item) => ({ from: item.offsets!.from as number, to: item.offsets!.to as number, text: item.text as string }));
}
