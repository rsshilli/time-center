/**
 * The rules for telling voices apart, on voiceprints (embeddings) from TitaNet-small, measured on real calls
 * (2026-11-10; PROGRESS.md). One line against a voice: the same person a median 0.73 (one in ten under 0.58),
 * someone else a median 0.13. A whole speaker against another (averages, which score higher): the same person in
 * different calls 0.89–0.99, different people up to 0.70.
 */

/** A line joins the call speaker it is closest to when it scores at least this. */
export const LINE_JOINS = 0.4;

/** A line shorter than this is too little voice to start a new speaker; it joins the closest at SHORT_LINE_JOINS. */
export const NEW_SPEAKER_MS = 2_000;

/** How close a short line must be to join a speaker; below it the line is left without one. */
export const SHORT_LINE_JOINS = 0.25;

/** A line shorter than this isn't worth a voiceprint; it takes the speaker of the line just before it. */
export const MIN_VOICE_MS = 700;

/** A call speaker is taken to be a named person, shown by name, at this score or more. */
export const VOICE_SURE = 0.8;

/** A call speaker this close to a named person is shown as a question ("Dana?") for you to confirm. */
export const VOICE_MAYBE = 0.7;

/** A speaker needs this many lines before a match is sure; fewer and it's only ever a question. */
export const SURE_NEEDS_LINES = 5;

/** Two speakers of one call this close are one person, merged when the call ends. */
export const SAME_PERSON = 0.8;

/** A speaker with fewer lines than this when the call ends is a stray (a cough, crosstalk), folded into another. */
export const STRAY_LINES = 3;

/** A stray is folded into the closest real speaker when it's at least this close; otherwise it stays. */
export const STRAY_JOINS = 0.5;

/** A voice in the making: the sum of its lines' unit voiceprints, and how many lines that is. */
export interface VoiceSum {
  sum: Float32Array;
  weight: number;
}

/** What to do with a new line's voiceprint. */
export type Pick = { kind: "join"; index: number; score: number } | { kind: "new" } | { kind: "none" };

/** A named person's voice. */
export interface KnownVoice {
  id: number;
  name: string;
  /** Unit length. */
  embedding: Float32Array;
}

/** Who a call speaker probably is. */
export interface VoiceMatch {
  voiceId: number;
  score: number;
  /** Whether it's close enough to show by name; otherwise it's a question. */
  sure: boolean;
}

/**
 * Decides which of a call's speakers said a line, or that it's someone new.
 * @param speakers The call's speakers so far.
 * @param voiceprint The line's voiceprint (any length; it's normalized here).
 * @param durationMs How long the line is.
 * @returns Join speaker `index`, start a new speaker, or leave the line without one.
 */
export function pickSpeaker(speakers: readonly VoiceSum[], voiceprint: Float32Array, durationMs: number): Pick {
  const best = closest(speakers, voiceprint);
  if (best && best.score >= LINE_JOINS) {
    return { kind: "join", index: best.index, score: best.score };
  }
  if (durationMs >= NEW_SPEAKER_MS) {
    return { kind: "new" };
  }
  if (best && best.score >= SHORT_LINE_JOINS) {
    return { kind: "join", index: best.index, score: best.score };
  }
  return { kind: "none" };
}

/**
 * Finds the named person a call speaker sounds most like.
 * @param speaker The call speaker.
 * @param voices Everyone named so far.
 * @returns The best match when it's at least VOICE_MAYBE, else null.
 */
export function matchVoice(speaker: VoiceSum, voices: readonly KnownVoice[]): VoiceMatch | null {
  const centroid = unit(speaker.sum);
  let best: VoiceMatch | null = null;
  for (const voice of voices) {
    const score = dot(centroid, voice.embedding);
    if (score >= VOICE_MAYBE && (!best || score > best.score)) {
      best = { voiceId: voice.id, score, sure: score >= VOICE_SURE && speaker.weight >= SURE_NEEDS_LINES };
    }
  }
  return best;
}

/**
 * Groups a call's speakers that are the same person, for merging when the call ends.
 * @param speakers The speakers.
 * @returns Groups of indexes, each sorted, the first of each group the one to keep; singletons left out.
 */
export function samePersonGroups(speakers: readonly VoiceSum[]): number[][] {
  const owner = speakers.map((_, index) => index);
  /**
   * @param index A speaker.
   * @returns The first speaker of its group.
   */
  const root = (index: number): number => (owner[index] === index ? index : (owner[index] = root(owner[index])));
  const centroids = speakers.map((speaker) => unit(speaker.sum));
  for (let a = 0; a < speakers.length; a++) {
    for (let b = a + 1; b < speakers.length; b++) {
      if (dot(centroids[a], centroids[b]) >= SAME_PERSON) {
        const [keep, fold] = [root(a), root(b)].sort((x, y) => x - y);
        owner[fold] = keep;
      }
    }
  }
  const groups = new Map<number, number[]>();
  speakers.forEach((_, index) => groups.set(root(index), [...(groups.get(root(index)) ?? []), index]));
  return [...groups.values()].filter((group) => group.length > 1);
}

/**
 * Finds where each stray speaker of a call belongs: the closest speaker with enough lines, when close enough.
 * @param speakers The call's speakers.
 * @returns Stray index → the index of the speaker to fold it into.
 */
export function strayHomes(speakers: readonly VoiceSum[]): Map<number, number> {
  const homes = new Map<number, number>();
  const real = speakers.map((speaker, index) => ({ index, centroid: unit(speaker.sum), weight: speaker.weight })).filter((each) => each.weight >= STRAY_LINES);
  speakers.forEach((speaker, index) => {
    if (speaker.weight >= STRAY_LINES) {
      return;
    }
    const centroid = unit(speaker.sum);
    let best: { index: number; score: number } | null = null;
    for (const candidate of real) {
      const score = dot(centroid, candidate.centroid);
      if (score >= STRAY_JOINS && (!best || score > best.score)) {
        best = { index: candidate.index, score };
      }
    }
    if (best) {
      homes.set(index, best.index);
    }
  });
  return homes;
}

/**
 * Adds a line's voiceprint to a voice in the making.
 * @param voice The voice; changed in place.
 * @param voiceprint The line's voiceprint.
 */
export function addLine(voice: VoiceSum, voiceprint: Float32Array): void {
  const line = unit(voiceprint);
  for (let i = 0; i < voice.sum.length; i++) {
    voice.sum[i] += line[i];
  }
  voice.weight += 1;
}

/**
 * Adds one voice in the making to another, e.g. a call speaker into the named person's voice.
 * @param into The voice that grows; changed in place.
 * @param from The voice added.
 */
export function addVoice(into: VoiceSum, from: VoiceSum): void {
  for (let i = 0; i < into.sum.length; i++) {
    into.sum[i] += from.sum[i];
  }
  into.weight += from.weight;
}

/**
 * The speaker a voiceprint is closest to.
 * @param speakers The candidates.
 * @param voiceprint The voiceprint.
 * @returns Its index and score, or null when there are none.
 */
function closest(speakers: readonly VoiceSum[], voiceprint: Float32Array): { index: number; score: number } | null {
  const line = unit(voiceprint);
  let best: { index: number; score: number } | null = null;
  speakers.forEach((speaker, index) => {
    const score = dot(line, unit(speaker.sum));
    if (!best || score > best.score) {
      best = { index, score };
    }
  });
  return best;
}

/**
 * A vector scaled to length 1 (a zero vector stays zero).
 * @param vector The vector.
 * @returns A new, unit-length vector.
 */
export function unit(vector: Float32Array): Float32Array {
  const length = Math.sqrt(dot(vector, vector));
  return vector.map((value) => (length > 0 ? value / length : 0));
}

/**
 * The dot product, which for unit vectors is the cosine: 1 is the same direction, 0 unrelated.
 * @param a One vector.
 * @param b Another of the same length.
 * @returns The product.
 */
export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}
