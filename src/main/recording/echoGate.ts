import { readFile, rename, writeFile } from "node:fs/promises";
import { readWav, SAMPLE_RATE } from "../speakers/wavSamples";

/**
 * Takes the other people's voices out of your microphone. On a Mac whose speakers play the call, the built-in
 * microphone hears them too, and they'd be transcribed as you. The recorder saves, beside each microphone chunk,
 * what the Mac was playing over the same stretch (the "reference", starting REF_LEAD_MS earlier). Any 20 ms of the
 * microphone that is no louder than the speakers' sound coming back would make it is silenced; your own voice,
 * close to the microphone, is far louder than that, so it stays, even said over someone else.
 */

/** How much earlier than its microphone chunk the reference starts, so a late echo can still be lined up. */
export const REF_LEAD_MS = 500;

/** The reference file saved beside a microphone chunk. */
export function refPath(wav: string): string {
  return `${wav}.ref`;
}

/** Where the gate's verdict on a chunk is kept, so a chunk read again (after a quit) gets the same one. */
export function verdictPath(wav: string): string {
  return `${wav}.gate`;
}

/** Samples in one 20 ms frame. */
const FRAME = SAMPLE_RATE / 50;

/** The echo's delay behind the reference is searched from this… */
const MIN_LAG_FRAMES = -5;

/** …to this (−100 ms to +500 ms: the speakers' own delay, plus the two sides' clocks drifting). */
const MAX_LAG_FRAMES = 25;

/** A reference frame quieter than this (RMS) is silence: nothing is playing to echo. */
const REF_QUIET = 0.003;

/** At least this many frames of the reference must be playing to measure an echo at all. */
const MIN_PLAYING_FRAMES = 25;

/**
 * The microphone and the reference must rise and fall together at least this much to count as an echo. Measured
 * 2026-11-18 on real voices (a recorded call, a simulated room): a real echo matched above 0.6 and two different
 * voices (headphones) never reached 0.3; 0.6 itself missed a real echo with you talking over half of it.
 */
const MIN_ECHO_MATCH = 0.45;

/** A microphone frame must be this much louder (in energy, 4 = 6 dB) than the echo predicted to be kept. */
const KEEP_MARGIN = 4;

/** The room keeps ringing after the sound stops: each 20 ms later the echo is assumed this much quieter. */
const RING_DECAY = 0.7;

/** How many frames back the ringing is followed. */
const RING_FRAMES = 10;

/** Frames ahead also counted, since the measured lag can be a frame or two late when you talk over them. */
const LOOKAHEAD_FRAMES = 3;

/** Frames kept on each side of a kept frame, so words aren't clipped. */
const HANGOVER_FRAMES = 3;

/** A frame at least this loud (RMS) is speech, as the recorder counts it. */
const SPEECH_RMS = 0.012;

/** A chunk with less speech than this left is not worth reading: whisper invents words out of near-silence. */
export const MIN_SPEECH_MS = 600;

/** What the gate did to one chunk. */
export interface GateResult {
  /** The microphone with the echo-only parts silenced. */
  samples: Float32Array;
  /** Whether the speakers' sound was found in the microphone. */
  echoFound: boolean;
  /** Whether anything was playing on the speakers over the chunk. */
  refPlaying: boolean;
  /** How much speech is left, in ms. */
  speechMs: number;
}

/**
 * Silences the parts of a microphone chunk that are only the speakers' sound coming back.
 * @param mic The microphone chunk, 16 kHz.
 * @param ref What the Mac played, 16 kHz, starting REF_LEAD_MS before the chunk.
 * @returns The chunk with the echo taken out, and how much speech is left.
 */
export function gateEcho(mic: Float32Array, ref: Float32Array): GateResult {
  const micEnergy = frameEnergies(mic);
  const refEnergy = frameEnergies(ref);
  const lead = Math.round(REF_LEAD_MS / 20);
  const echo = findEcho(micEnergy, refEnergy, lead);
  const refPlaying = refEnergy.filter((energy) => energy >= REF_QUIET ** 2).length >= MIN_PLAYING_FRAMES;
  if (echo === null) {
    return { samples: mic, echoFound: false, refPlaying, speechMs: speechMs(micEnergy) };
  }
  const keep = micEnergy.map((energy, frame) => energy > KEEP_MARGIN * echo.gain * ringingAt(refEnergy, frame + lead - echo.lag));
  const kept = widen(keep);
  const samples = new Float32Array(mic);
  const keptEnergy: number[] = [];
  for (let frame = 0; frame < micEnergy.length; frame++) {
    if (!kept[frame]) {
      samples.fill(0, frame * FRAME, (frame + 1) * FRAME);
      keptEnergy.push(0);
    } else {
      keptEnergy.push(micEnergy[frame]);
    }
  }
  return { samples, echoFound: true, refPlaying, speechMs: speechMs(keptEnergy) };
}

/**
 * Finds how far the echo lags the reference and how loud it comes back: the lag at which the microphone's
 * loudness follows the reference's most closely, and the microphone-to-reference energy ratio there (a low
 * quantile, since frames where you talk over them only raise it). Looking in short stretches instead was tried
 * and dropped: the best of many small samples made two different voices look like an echo.
 * @param mic The microphone's frame energies.
 * @param ref The reference's.
 * @param lead How many frames the reference starts early.
 * @returns The lag in frames and the echo's energy gain, or null when the microphone doesn't follow the reference
 *   (nothing playing, or headphones).
 */
export function findEcho(mic: readonly number[], ref: readonly number[], lead: number): { lag: number; gain: number } | null {
  let best: { lag: number; match: number } | null = null;
  for (let lag = MIN_LAG_FRAMES; lag <= MAX_LAG_FRAMES; lag++) {
    const pairs: [number, number][] = [];
    for (let frame = 0; frame < mic.length; frame++) {
      const at = frame + lead - lag;
      if (at >= 0 && at < ref.length && ref[at] >= REF_QUIET ** 2) {
        pairs.push([Math.log(mic[frame] + 1e-10), Math.log(ref[at] + 1e-10)]);
      }
    }
    if (pairs.length < MIN_PLAYING_FRAMES) {
      continue;
    }
    const match = correlation(pairs);
    if (best === null || match > best.match) {
      best = { lag, match };
    }
  }
  if (best === null || best.match < MIN_ECHO_MATCH) {
    return null;
  }
  const ratios: number[] = [];
  for (let frame = 0; frame < mic.length; frame++) {
    const at = frame + lead - best.lag;
    if (at >= 0 && at < ref.length && ref[at] >= REF_QUIET ** 2) {
      ratios.push(mic[frame] / ref[at]);
    }
  }
  ratios.sort((a, b) => a - b);
  return { lag: best.lag, gain: ratios[Math.floor(ratios.length * 0.3)] };
}

/**
 * The reference's loudness at a frame as the room would still carry it: the loudest of it, the few frames just
 * after (in case the lag was measured late) and the frames just before, each fading by RING_DECAY per frame.
 * @param ref The reference's frame energies.
 * @param at The frame.
 * @returns The energy.
 */
function ringingAt(ref: readonly number[], at: number): number {
  let loudest = 0;
  for (let ahead = 1; ahead <= LOOKAHEAD_FRAMES; ahead++) {
    loudest = Math.max(loudest, ref[at + ahead] ?? 0);
  }
  let fade = 1;
  for (let back = 0; back <= RING_FRAMES; back++) {
    const frame = at - back;
    if (frame >= 0 && frame < ref.length) {
      loudest = Math.max(loudest, ref[frame] * fade);
    }
    fade *= RING_DECAY;
  }
  return loudest;
}

/**
 * Keeps a few frames either side of every kept frame.
 * @param keep Which frames are kept.
 * @returns The widened choice.
 */
function widen(keep: readonly boolean[]): boolean[] {
  return keep.map((_, frame) => {
    for (let near = frame - HANGOVER_FRAMES; near <= frame + HANGOVER_FRAMES; near++) {
      if (keep[near]) {
        return true;
      }
    }
    return false;
  });
}

/**
 * The mean square of each 20 ms frame.
 * @param samples The audio.
 * @returns One energy per whole frame.
 */
export function frameEnergies(samples: Float32Array): number[] {
  const energies: number[] = [];
  for (let start = 0; start + FRAME <= samples.length; start += FRAME) {
    let sum = 0;
    for (let index = start; index < start + FRAME; index++) {
      sum += samples[index] * samples[index];
    }
    energies.push(sum / FRAME);
  }
  return energies;
}

/**
 * How much speech some frames hold.
 * @param energies Their energies.
 * @returns The ms at least SPEECH_RMS loud.
 */
function speechMs(energies: readonly number[]): number {
  return energies.filter((energy) => energy >= SPEECH_RMS ** 2).length * 20;
}

/**
 * Pearson correlation of paired values.
 * @param pairs The pairs.
 * @returns −1 to 1; 0 when either side doesn't vary.
 */
function correlation(pairs: readonly [number, number][]): number {
  const n = pairs.length;
  const meanA = pairs.reduce((sum, pair) => sum + pair[0], 0) / n;
  const meanB = pairs.reduce((sum, pair) => sum + pair[1], 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (const [a, b] of pairs) {
    cov += (a - meanA) * (b - meanB);
    varA += (a - meanA) ** 2;
    varB += (b - meanB) ** 2;
  }
  return varA === 0 || varB === 0 ? 0 : cov / Math.sqrt(varA * varB);
}

/**
 * Takes the echo out of a microphone chunk on disk, when the recorder saved its reference: the chunk is rewritten
 * with the echo silenced, and the verdict is kept beside it until the chunk is finished with (the transcriber
 * deletes the chunk, its reference and its verdict), so a chunk read again after a quit gets the same verdict
 * rather than gating its already-cleaned audio. A chunk with no reference (an older recorder) is left as it is.
 * @param wav The chunk.
 * @returns Whether it's worth transcribing (false: the echo was taken out and too little was left), and whether
 *   its lines are surely you (gated: the echo was found and taken out, or nothing was playing). With something
 *   playing but no echo found (headphones, or the two sides too far out of line to tell), it's read as it is and
 *   not counted as clean.
 */
export async function gateChunkFile(wav: string): Promise<{ worthReading: boolean; gated: boolean }> {
  const earlier = await readVerdict(wav);
  if (earlier) {
    return earlier;
  }
  let refBytes: Uint8Array;
  try {
    refBytes = await readFile(refPath(wav));
  } catch {
    return { worthReading: true, gated: false };
  }
  const mic = readWav(await readFile(wav)).samples;
  const result = gateEcho(mic, readWav(refBytes).samples);
  if (result.echoFound) {
    const partial = `${wav}.gating`;
    await writeFile(partial, wavBytes(result.samples));
    await rename(partial, wav);
  }
  const verdict = {
    worthReading: !result.echoFound || result.speechMs >= MIN_SPEECH_MS,
    gated: result.echoFound || !result.refPlaying,
  };
  await writeFile(verdictPath(wav), JSON.stringify(verdict));
  return verdict;
}

/**
 * The verdict kept from gating a chunk before.
 * @param wav The chunk.
 * @returns It, or null when the chunk hasn't been gated (or the file is unreadable).
 */
async function readVerdict(wav: string): Promise<{ worthReading: boolean; gated: boolean } | null> {
  try {
    const saved = JSON.parse(await readFile(verdictPath(wav), "utf8")) as { worthReading?: unknown; gated?: unknown };
    return typeof saved.worthReading === "boolean" && typeof saved.gated === "boolean" ? { worthReading: saved.worthReading, gated: saved.gated } : null;
  } catch {
    return null;
  }
}

/**
 * Writes samples as a 16 kHz mono 16-bit WAV, as the recorder does.
 * @param samples The audio, −1 to 1.
 * @returns The file's bytes.
 */
export function wavBytes(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => [...text].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index++) {
    view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, samples[index])) * 32_767), true);
  }
  return bytes;
}
