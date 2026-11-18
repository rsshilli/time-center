import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_SPEECH_MS, REF_LEAD_MS, frameEnergies, gateChunkFile, gateEcho, refPath, wavBytes } from "../../src/main/recording/echoGate";
import { readWav } from "../../src/main/speakers/wavSamples";

const RATE = 16_000;

/** A repeatable random number source, so the made-up voices are the same every run. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/** Made-up speech: noise swelling and fading in syllables about 4 a second, with pauses, `seconds` long. */
function voice(seconds: number, seed: number, loudness: number): Float32Array {
  const next = random(seed);
  const samples = new Float32Array(seconds * RATE);
  let syllableStart = 0;
  let syllableEnd = 0;
  let level = 0;
  for (let index = 0; index < samples.length; index++) {
    if (index >= syllableEnd) {
      syllableStart = index;
      syllableEnd = index + Math.round((0.12 + next() * 0.2) * RATE);
      level = next() < 0.25 ? 0 : loudness * (0.5 + next());
    }
    // Each syllable swells and fades, as speech does, rather than switching on and off.
    const shape = Math.sin((Math.PI * (index - syllableStart)) / (syllableEnd - syllableStart)) ** 2;
    samples[index] = (next() * 2 - 1) * level * shape;
  }
  return samples;
}

/** What the microphone hears of the speakers: the sound later by `delayMs`, quieter, with one wall reflection. */
function echoOf(played: Float32Array, delayMs: number, gain: number): Float32Array {
  const delay = Math.round((delayMs / 1000) * RATE);
  const wall = delay + Math.round(0.03 * RATE);
  const heard = new Float32Array(played.length);
  for (let index = 0; index < heard.length; index++) {
    heard[index] = gain * ((played[index - delay] ?? 0) + 0.4 * (played[index - wall] ?? 0));
  }
  return heard;
}

/** Adds signals together. */
function mix(...signals: Float32Array[]): Float32Array {
  const out = new Float32Array(signals[0].length);
  for (const signal of signals) {
    signal.forEach((value, index) => (out[index] += value));
  }
  return out;
}

/** The reference the recorder would save for a microphone chunk: what played, starting REF_LEAD_MS earlier. */
function referenceFor(played: Float32Array): Float32Array {
  const lead = (REF_LEAD_MS / 1000) * RATE;
  const ref = new Float32Array(played.length + lead);
  ref.set(played, lead);
  return ref;
}

/** How much of a signal's energy is left in another. */
function energyLeft(original: Float32Array, after: Float32Array): number {
  const sum = (samples: number[]) => samples.reduce((total, value) => total + value, 0);
  return sum(frameEnergies(after)) / sum(frameEnergies(original));
}

describe("gateEcho", () => {
  const others = voice(10, 1, 0.3);

  it("should silence a microphone that only hears the speakers, leaving nothing worth reading", () => {
    const mic = mix(echoOf(others, 80, 0.15), voice(10, 9, 0.001));

    const result = gateEcho(mic, referenceFor(others));

    expect(result.echoFound).toBe(true);
    expect(result.speechMs).toBeLessThan(MIN_SPEECH_MS);
    expect(energyLeft(mic, result.samples)).toBeLessThan(0.1);
  });

  it("should keep your voice when you talk over them, and silence the echo before you start", () => {
    const you = voice(9, 2, 0.4);
    // You speak over the last third. (Real voices from a recorded call passed with you over half the chunk: 93% of
    // you kept. These made-up voices don't pass at half; see the next test for what happens then.)
    you.fill(0, 0, 6 * RATE);
    const played = voice(9, 1, 0.3);
    const mic = mix(echoOf(played, 80, 0.15), you);

    const result = gateEcho(mic, referenceFor(played));

    expect(result.echoFound).toBe(true);
    expect(energyLeft(mic.subarray(6 * RATE), result.samples.subarray(6 * RATE))).toBeGreaterThan(0.85);
    expect(energyLeft(mic.subarray(0, 6 * RATE), result.samples.subarray(0, 6 * RATE))).toBeLessThan(0.1);
    expect(result.speechMs).toBeGreaterThan(1_500);
  });

  it("should leave the microphone as it was when you talk over most of the chunk and the echo can't be told", () => {
    const you = voice(10, 2, 0.4);
    const played = voice(10, 1, 0.3);
    const mic = mix(echoOf(played, 80, 0.15), you);

    const result = gateEcho(mic, referenceFor(played));

    expect(result.echoFound).toBe(false);
    expect(result.refPlaying).toBe(true);
    expect(result.samples).toBe(mic);
  });

  it("should leave the microphone alone when it doesn't follow the speakers (headphones)", () => {
    const you = voice(10, 3, 0.3);

    const result = gateEcho(you, referenceFor(others));

    expect(result.echoFound).toBe(false);
    expect(result.samples).toBe(you);
  });

  it("should leave the microphone alone when nothing was playing", () => {
    const you = voice(10, 4, 0.3);

    const result = gateEcho(you, new Float32Array(you.length + (REF_LEAD_MS / 1000) * RATE));

    expect(result.echoFound).toBe(false);
    expect(result.speechMs).toBeGreaterThan(5_000);
  });
});

describe("gateChunkFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "echo-gate-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("should rewrite the chunk with the echo taken out, keeping its reference for a second read", async () => {
    const others = voice(6, 5, 0.3);
    const wav = join(dir, "me-1-1.wav");
    writeFileSync(wav, wavBytes(echoOf(others, 60, 0.15)));
    writeFileSync(refPath(wav), wavBytes(referenceFor(others)));

    expect(await gateChunkFile(wav)).toEqual({ worthReading: false, gated: true });
    expect(existsSync(refPath(wav))).toBe(true);
    // Read again (the app quit before whisper finished): still clean, still nothing left.
    expect(await gateChunkFile(wav)).toEqual({ worthReading: false, gated: true });
    expect(Math.max(...readWav(readFileSync(wav)).samples.map(Math.abs))).toBeLessThan(0.02);
  });

  it("should read a chunk as it is, not counted as clean, when something played but no echo was found", async () => {
    const wav = join(dir, "me-1-1.wav");
    const bytes = wavBytes(voice(6, 7, 0.3));
    writeFileSync(wav, bytes);
    writeFileSync(refPath(wav), wavBytes(referenceFor(voice(6, 8, 0.3))));

    expect(await gateChunkFile(wav)).toEqual({ worthReading: true, gated: false });
    expect(new Uint8Array(readFileSync(wav))).toEqual(bytes);
  });

  it("should count a chunk as clean when nothing was playing", async () => {
    const wav = join(dir, "me-1-1.wav");
    writeFileSync(wav, wavBytes(voice(6, 9, 0.3)));
    writeFileSync(refPath(wav), wavBytes(new Float32Array(6.5 * RATE)));

    expect(await gateChunkFile(wav)).toEqual({ worthReading: true, gated: true });
  });

  it("should leave a chunk with no reference as it is", async () => {
    const wav = join(dir, "me-1-1.wav");
    const bytes = wavBytes(voice(2, 6, 0.3));
    writeFileSync(wav, bytes);

    expect(await gateChunkFile(wav)).toEqual({ worthReading: true, gated: false });
    expect(new Uint8Array(readFileSync(wav))).toEqual(bytes);
  });
});
