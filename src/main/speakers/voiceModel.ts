import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SAMPLE_RATE } from "./wavSamples";

/** The voice model: NVIDIA NeMo TitaNet-small, exported for sherpa-onnx (chosen by measuring three; PROGRESS.md). */
export const VOICE_MODEL_FILE = "nemo_en_titanet_small.onnx";

/** Where it's downloaded from the first time (40 MB). */
export const VOICE_MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/${VOICE_MODEL_FILE}`;

/** How long the download may take before it's abandoned (and tried again at the next catch-up). */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** The download must be exactly this file. */
const VOICE_MODEL_SHA256 = "ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e";

/** Turns a stretch of speech into a voiceprint. */
export interface VoicePrinter {
  /**
   * @param samples 16 kHz mono speech.
   * @returns Its voiceprint (192 numbers), a copy the caller owns.
   */
  voiceprint(samples: Float32Array): Float32Array;
}

/** A download in progress, shared by every caller. */
let downloading: Promise<string> | null = null;

/**
 * Loads the voice model, downloading it into the app's models folder the first time.
 * @param modelsDir The app's models folder.
 * @returns Something that makes voiceprints.
 */
export async function loadVoicePrinter(modelsDir: string): Promise<VoicePrinter> {
  const model = join(modelsDir, VOICE_MODEL_FILE);
  if (!existsSync(model)) {
    downloading ??= downloadModel(model).finally(() => {
      downloading = null;
    });
    await downloading;
  }
  // Loaded only when needed: it's a native module, and tests run without it.
  const loaded = await import("sherpa-onnx-node");
  const sherpa = ("default" in loaded ? loaded.default : loaded) as typeof import("sherpa-onnx-node");
  let extractor: InstanceType<typeof sherpa.SpeakerEmbeddingExtractor>;
  try {
    extractor = new sherpa.SpeakerEmbeddingExtractor({ model, numThreads: 1 });
  } catch (error) {
    // A damaged file (cut short by a power cut): removed, so the next try downloads it again.
    await rm(model, { force: true });
    throw error;
  }
  return {
    voiceprint: (samples) => {
      const stream = extractor.createStream();
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
      stream.inputFinished();
      // false: a copy in JavaScript's memory rather than a view of sherpa-onnx's.
      return Float32Array.from(extractor.compute(stream, false));
    },
  };
}

/**
 * Downloads the model, checks it's the expected file, then moves it into place.
 * @param model Where it belongs.
 * @returns The path.
 */
async function downloadModel(model: string): Promise<string> {
  await mkdir(dirname(model), { recursive: true });
  // A stalled download gives up rather than holding every later call's speakers forever.
  const response = await fetch(VOICE_MODEL_URL, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Couldn't download the voice model (HTTP ${response.status}).`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== VOICE_MODEL_SHA256) {
    throw new Error("The voice model downloaded wasn't the expected file.");
  }
  const partial = `${model}.part`;
  try {
    await writeFile(partial, bytes);
    await rename(partial, model);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return model;
}
