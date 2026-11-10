import { YOUR_VOICE, yourOwnLines } from "../../shared/transcript";
import type { AudioChunk } from "../recording/recorderProcess";
import {
  MIN_VOICE_MS,
  NEW_SPEAKER_MS,
  addLine,
  addVoice,
  matchVoice,
  pickSpeaker,
  samePersonGroups,
  strayHomes,
  unit,
  type VoiceSum,
} from "./speakerMath";
import type { SpeakerStore, StoredSpeaker, TheirLine } from "./SpeakerStore";
import type { VoicePrinter } from "./voiceModel";
import { SAMPLE_RATE, alignOffset, slice } from "./wavSamples";

/** A short line takes the speaker of the line before it only if that ended within this long. */
const FOLLOWS_WITHIN_MS = 2_000;

/** How many of your microphone's lines per call go into your voice. */
const YOUR_LINES_PER_CALL = 40;

/** The longest name accepted. */
export const MAX_NAME_CHARS = 80;

/** What the speaker service needs, injected for tests. */
export interface SpeakerServiceDeps {
  store: SpeakerStore;
  /** Loads the voice model (downloading it the first time). */
  loadPrinter(): Promise<VoicePrinter>;
  /** A chunk's samples (16 kHz mono WAV). */
  readChunk(wav: string): Promise<Float32Array>;
  /** A call's mixed audio file's samples, decoded to 16 kHz mono. */
  readCall(audioPath: string): Promise<Float32Array>;
  /** When a call started, the time its mixed audio file roughly begins at. */
  recordingStart(recordingId: number): number | null;
  /** Whether a call's chunks are still waiting for whisper (its speakers aren't final until they're read). */
  stillTranscribing(recordingId: number): boolean;
  /** Whether a call is being recorded now (going back over old calls waits, to leave the Mac to the call). */
  isRecording(): boolean;
  /** Lets other work run between lines; each voiceprint takes ~50 ms of the main thread. */
  yieldNow(): Promise<void>;
  now(): number;
  log(message: string, error?: unknown): void;
}

/**
 * Tells the voices on the other side of a call apart ("Speaker 1", "Speaker 2"…) as the call is transcribed,
 * recognizes people you've named before, and goes back over calls recorded before this existed.
 */
export class SpeakerService {
  private printer: Promise<VoicePrinter> | null = null;
  /** The model once loaded, for chunks, which never wait for it. */
  private loaded: VoicePrinter | null = null;
  private catchingUp = false;
  private catchUpAgain = false;

  /** @param deps The store, the voice model and the audio. */
  constructor(private readonly deps: SpeakerServiceDeps) {}

  /**
   * Assigns the lines whisper just heard in a chunk from the other side to speakers. Never throws: a
   * problem marks the call to be split again from its audio file later.
   * @param recordingId The call.
   * @param chunk The chunk.
   * @param lines Its stored lines.
   */
  async chunkTranscribed(recordingId: number, chunk: AudioChunk, lines: TheirLine[]): Promise<void> {
    if (chunk.side !== "them" || lines.length === 0) {
      return;
    }
    const printer = this.loaded;
    if (!printer) {
      // Not loaded yet (the first time it's a 40 MB download): never hold up transcription for it. The call
      // is split from its audio file once it ends.
      this.deps.store.setState(recordingId, "redo");
      this.loadPrinter().catch((error: unknown) => this.deps.log("Time Center: the voice model isn't available yet", error));
      return;
    }
    try {
      const samples = await this.deps.readChunk(chunk.wav);
      const earlier = this.deps.store.listTheirLines(recordingId).filter((line) => !lines.some((mine) => mine.id === line.id));
      const state = this.deps.store.getState(recordingId);
      if (state === null && earlier.some((line) => line.speakerId === null)) {
        // Lines from before speakers existed (or before the model loaded): only a split from the file covers them.
        this.deps.store.setState(recordingId, "redo");
        return;
      }
      if (state === null || state === "done") {
        // "done": a late chunk; the next catch-up tidies the call again.
        this.deps.store.setState(recordingId, "live");
      }
      if (state === "redo" || state === "failed") {
        return;
      }
      const speakers = this.deps.store.listSpeakers(recordingId);
      const before = earlier.filter((line) => line.end <= lines[0].start).at(-1) ?? null;
      this.assignLines(recordingId, speakers, lines, before, (line) => voiceprintOf(printer, slice(samples, line.start - chunk.t0, line.end - chunk.t0)));
      this.matchSpeakers(speakers);
    } catch (error) {
      this.deps.log(`Time Center: couldn't tell the voices apart in ${chunk.wav}`, error);
      this.deps.store.setState(recordingId, "redo");
    }
  }

  /** Loads the voice model now (downloading it the first time), so the first call's voices are split live. */
  async prepareAhead(): Promise<void> {
    try {
      await this.loadPrinter();
    } catch (error) {
      this.deps.log("Time Center: the voice model isn't available yet", error);
    }
  }

  /**
   * Finishes every call whose voices aren't final: tidies calls split live, and splits the others (recorded
   * before this, or after a problem) from their audio files, newest first. Runs one at a time; a call
   * coming in meanwhile makes it go round again.
   */
  async catchUp(): Promise<void> {
    if (this.catchingUp) {
      this.catchUpAgain = true;
      return;
    }
    this.catchingUp = true;
    try {
      // Without the model (offline on first use) nothing is marked; the next catch-up tries again.
      await this.loadPrinter();
      do {
        this.catchUpAgain = false;
        for (const call of this.deps.store.listToSplit()) {
          if (this.deps.isRecording()) {
            return;
          }
          if (this.deps.stillTranscribing(call.id)) {
            continue;
          }
          await this.finishCall(call.id, call.audioPath, call.state);
        }
        for (const call of this.deps.store.listToLearnYourVoice()) {
          if (this.deps.isRecording()) {
            return;
          }
          await this.learnYourVoice(call.id, call.audioPath);
        }
      } while (this.catchUpAgain);
    } catch (error) {
      this.deps.log("Time Center: the voice model isn't available yet", error);
    } finally {
      this.catchingUp = false;
    }
  }

  /**
   * Says who a call speaker is (a new name or someone named before), or that it's nobody named so far (null:
   * "Speaker N" for good, never guessed again). Their voice joins that person's, and every speaker you haven't
   * named is matched again.
   * @param speakerId The speaker.
   * @param name The name, or null.
   */
  nameSpeaker(speakerId: number, name: string | null): void {
    const speaker = this.deps.store.getSpeaker(speakerId);
    if (!speaker) {
      throw new Error("That speaker is no longer in the call.");
    }
    if (name !== null && name.length > MAX_NAME_CHARS * 4) {
      throw new Error(`A name can be 1 to ${MAX_NAME_CHARS} characters.`);
    }
    const typed = name?.trim().replace(/\s+/g, " ") ?? "";
    if (name !== null && (typed === "" || typed.length > MAX_NAME_CHARS)) {
      throw new Error(`A name can be 1 to ${MAX_NAME_CHARS} characters.`);
    }
    // Your own voice always has the one spelling the transcript looks for.
    const trimmed = typed.toLowerCase() === YOUR_VOICE.toLowerCase() ? YOUR_VOICE : typed;
    if (speaker.confirmed && speaker.voiceId !== null && speaker.named) {
      // Named before: exactly what they added to that person's voice comes out again.
      this.changeVoice(speaker.voiceId, speaker.named, -1);
    }
    if (name === null) {
      this.deps.store.setConfirmed(speakerId, null, null);
    } else {
      const existing = this.deps.store.findVoice(trimmed);
      const voiceId = existing ? existing.id : this.deps.store.addVoice(trimmed, { sum: new Float32Array(speaker.sum.length), weight: 0 }, this.deps.now());
      const added = { sum: Float32Array.from(speaker.sum), weight: speaker.weight };
      this.changeVoice(voiceId, added, 1);
      this.deps.store.setConfirmed(speakerId, voiceId, added);
    }
    this.matchSpeakers(this.deps.store.listUnconfirmedSpeakers());
  }

  /**
   * Renames a person everywhere.
   * @param voiceId The person.
   * @param name Their new name.
   */
  renameVoice(voiceId: number, name: string): void {
    const trimmed = name.trim().replace(/\s+/g, " ");
    if (trimmed === "" || trimmed.length > MAX_NAME_CHARS) {
      throw new Error(`A name can be 1 to ${MAX_NAME_CHARS} characters.`);
    }
    const other = this.deps.store.findVoice(trimmed);
    if (other && other.id !== voiceId) {
      throw new Error(`There's already someone called ${other.name}.`);
    }
    this.deps.store.renameVoice(voiceId, trimmed);
  }

  /**
   * Forgets a person and their voice; their calls go back to "Speaker N" and are matched again.
   * @param voiceId The person.
   */
  forgetVoice(voiceId: number): void {
    this.deps.store.deleteVoice(voiceId);
    this.matchSpeakers(this.deps.store.listUnconfirmedSpeakers());
  }

  /**
   * Loads the voice model once; a failed load is tried again next time.
   * @returns The model.
   */
  private loadPrinter(): Promise<VoicePrinter> {
    this.printer ??= this.deps.loadPrinter().then(
      (printer) => {
        this.loaded = printer;
        return printer;
      },
      (error: unknown) => {
        this.printer = null;
        throw error;
      },
    );
    return this.printer;
  }

  /**
   * Makes a call's speakers final: splits it from its audio file when it wasn't split live, then merges
   * speakers that turned out to be one person and matches them to people named before.
   * @param recordingId The call.
   * @param audioPath Its mixed audio file.
   * @param state Where it stands.
   */
  private async finishCall(recordingId: number, audioPath: string, state: string | null): Promise<void> {
    try {
      if (state !== "live") {
        await this.splitFromFile(recordingId, audioPath);
      }
      this.mergeSamePerson(recordingId);
      this.foldStrays(recordingId);
      this.matchSpeakers(this.deps.store.listSpeakers(recordingId));
      this.deps.store.setState(recordingId, "done");
    } catch (error) {
      this.deps.log(`Time Center: couldn't tell the voices apart in call ${recordingId}`, error);
      this.deps.store.setState(recordingId, "failed");
    }
  }

  /**
   * Learns your voice from a finished call: your microphone is always you, so its lines that are surely you
   * (see yourOwnLines) are added to the "You" voice, and every speaker you haven't named is matched again. On
   * calls where the Mac's sound carried your voice to the other side, that speaker is then shown as you, and
   * its lines that repeat your microphone's are left out. Never throws; a call is tried once.
   * @param recordingId The call.
   * @param audioPath Its mixed audio file.
   */
  private async learnYourVoice(recordingId: number, audioPath: string): Promise<void> {
    try {
      const printer = await this.loadPrinter();
      const start = this.deps.recordingStart(recordingId);
      const lines = this.deps.store.listCallLines(recordingId);
      // The longest lines tell a voice best; a few dozen per call is plenty, and keeps a long call quick.
      const own = yourOwnLines(lines)
        .filter((line) => line.end - line.start >= NEW_SPEAKER_MS)
        .sort((a, b) => b.end - b.start - (a.end - a.start))
        .slice(0, YOUR_LINES_PER_CALL);
      const prints: Float32Array[] = [];
      if (start !== null && own.length > 0) {
        const samples = await this.deps.readCall(audioPath);
        const offset = alignOffset(samples, lines.map((line) => ({ start: line.start - start, end: line.end - start })));
        for (const line of own) {
          const print = voiceprintOf(printer, slice(samples, line.start - start - offset, line.end - start - offset));
          if (print) {
            prints.push(print);
          }
          await this.deps.yieldNow();
        }
      }
      if (prints.length > 0) {
        const heard: VoiceSum = { sum: new Float32Array(prints[0].length), weight: 0 };
        for (const print of prints) {
          addLine(heard, print);
        }
        const voiceId = this.deps.store.findVoice(YOUR_VOICE)?.id ?? this.deps.store.addVoice(YOUR_VOICE, { sum: new Float32Array(heard.sum.length), weight: 0 }, this.deps.now());
        this.changeVoice(voiceId, heard, 1);
        this.matchSpeakers(this.deps.store.listUnconfirmedSpeakers());
      }
    } catch (error) {
      this.deps.log(`Time Center: couldn't learn your voice from call ${recordingId}`, error);
    }
    this.deps.store.setYourVoiceLearned(recordingId, this.deps.now());
  }

  /**
   * Splits a whole call's other side into speakers from its mixed audio file, keeping who you'd named.
   * @param recordingId The call.
   * @param audioPath Its mixed audio file.
   */
  private async splitFromFile(recordingId: number, audioPath: string): Promise<void> {
    const printer = await this.loadPrinter();
    const start = this.deps.recordingStart(recordingId);
    if (start === null) {
      return;
    }
    let samples: Float32Array | null = await this.deps.readCall(audioPath);
    // The slow part first, yielding between lines; the store isn't touched until every voiceprint is made, so
    // a failure here loses nothing.
    const offset = alignOffset(samples, this.deps.store.listTheirLines(recordingId).map((line) => ({ start: line.start - start, end: line.end - start })));
    const prints = new Map<number, Float32Array | null>();
    for (const line of this.deps.store.listTheirLines(recordingId)) {
      if (line.end - line.start >= MIN_VOICE_MS) {
        prints.set(line.id, voiceprintOf(printer, slice(samples, line.start - start - offset, line.end - start - offset)));
        await this.deps.yieldNow();
      }
    }
    samples = null;
    // Then all at once, with no await in between, so naming a speaker meanwhile can't be overwritten.
    const old = this.deps.store.listSpeakers(recordingId).filter((speaker) => speaker.confirmed);
    const named = new Map(old.map((speaker) => [speaker.id, speaker.voiceId]));
    const lines = this.deps.store.listTheirLines(recordingId);
    const namedLines = lines.filter((line) => line.speakerId !== null && named.has(line.speakerId)).map((line) => ({ ...line }));
    this.deps.store.clearSpeakers(recordingId);
    const speakers: StoredSpeaker[] = [];
    try {
      this.assignLines(recordingId, speakers, lines, null, (line) => prints.get(line.id) ?? null);
    } finally {
      this.restoreNames(recordingId, speakers, namedLines, named);
    }
  }

  /**
   * After splitting again, gives each new speaker the name you'd given the old speaker most of its lines had.
   * @param recordingId The call.
   * @param speakers The new speakers.
   * @param namedLines The lines that had a named speaker, with that speaker.
   * @param named Old speaker → the person you named.
   */
  private restoreNames(recordingId: number, speakers: StoredSpeaker[], namedLines: TheirLine[], named: Map<number, number | null>): void {
    const now = new Map(this.deps.store.listTheirLines(recordingId).map((line) => [line.id, line.speakerId]));
    for (const speaker of speakers) {
      // -1 stands for "nobody named so far" ("Not Dana"), which is kept too.
      const votes = new Map<number, number>();
      for (const line of namedLines) {
        const voiceId = named.get(line.speakerId as number) ?? -1;
        if (now.get(line.id) === speaker.id) {
          votes.set(voiceId, (votes.get(voiceId) ?? 0) + 1);
        }
      }
      const winner = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
      if (winner) {
        // Nothing is added to the person's voice: it already holds this call from when you named them.
        this.deps.store.setConfirmed(speaker.id, winner[0] === -1 ? null : winner[0], null);
      }
    }
  }

  /**
   * Gives each line a speaker: an existing one whose voice it's close to, a new one, or (too short to tell)
   * the speaker of the line just before it.
   * @param recordingId The call.
   * @param speakers The call's speakers; new ones are added to it, and voices grow in place.
   * @param lines The lines, in order.
   * @param before The line before the first, if any.
   * @param voiceprintOf Makes a line's voiceprint.
   */
  private assignLines(
    recordingId: number,
    speakers: StoredSpeaker[],
    lines: TheirLine[],
    before: TheirLine | null,
    voiceprintOf: (line: TheirLine) => Float32Array | null,
  ): void {
    let previous = before;
    for (const line of lines) {
      let speakerId: number | null = null;
      const voiceprint = line.end - line.start < MIN_VOICE_MS ? null : voiceprintOf(line);
      if (!voiceprint) {
        speakerId = previous && line.start - previous.end <= FOLLOWS_WITHIN_MS ? previous.speakerId : null;
      } else {
        const pick = pickSpeaker(speakers, voiceprint, line.end - line.start);
        if (pick.kind === "join") {
          const speaker = speakers[pick.index];
          addLine(speaker, voiceprint);
          this.deps.store.saveSpeakerVoice(speaker.id, speaker);
          speakerId = speaker.id;
        } else if (pick.kind === "new") {
          const speaker = this.deps.store.addSpeaker(recordingId, { sum: unit(voiceprint), weight: 1 });
          speakers.push(speaker);
          speakerId = speaker.id;
        }
      }
      this.deps.store.setLineSpeaker(line.id, speakerId);
      line.speakerId = speakerId;
      previous = line;
    }
  }

  /**
   * Merges a call's speakers that sound like one person (a voice split early on, before it had enough lines).
   * Two speakers you named as different people are never merged.
   * @param recordingId The call.
   */
  private mergeSamePerson(recordingId: number): void {
    const speakers = this.deps.store.listSpeakers(recordingId);
    for (const group of samePersonGroups(speakers)) {
      const members = group.map((index) => speakers[index]);
      const names = new Set(members.filter((speaker) => speaker.confirmed).map((speaker) => speaker.voiceId));
      if (names.size > 1) {
        continue;
      }
      // The named one stays (keeping its name), else the one heard most.
      const keep = members.find((speaker) => speaker.confirmed) ?? members.reduce((a, b) => (b.weight > a.weight ? b : a));
      const folded = members.filter((speaker) => speaker !== keep);
      for (const speaker of folded) {
        addVoice(keep, speaker);
      }
      this.deps.store.mergeSpeakers(keep, folded);
    }
  }

  /**
   * Folds a call's stray speakers (a line or two: a cough, crosstalk) into the closest real speaker, so the
   * transcript doesn't fill with "Speaker 11"s. A speaker you named is never folded.
   * @param recordingId The call.
   */
  private foldStrays(recordingId: number): void {
    const speakers = this.deps.store.listSpeakers(recordingId);
    const into = new Map<number, StoredSpeaker[]>();
    for (const [stray, home] of strayHomes(speakers)) {
      if (!speakers[stray].confirmed) {
        into.set(home, [...(into.get(home) ?? []), speakers[stray]]);
      }
    }
    for (const [home, strays] of into) {
      const keep = speakers[home];
      for (const stray of strays) {
        addVoice(keep, stray);
      }
      this.deps.store.mergeSpeakers(keep, strays);
    }
  }

  /**
   * Matches speakers you haven't named to the people named so far.
   * @param speakers The speakers.
   */
  private matchSpeakers(speakers: StoredSpeaker[]): void {
    const voices = this.deps.store.knownVoices();
    for (const speaker of speakers.filter((each) => !each.confirmed)) {
      const match = matchVoice(speaker, voices);
      this.deps.store.setMatch(speaker.id, match?.voiceId ?? null, match?.score ?? null);
    }
  }

  /**
   * Adds a speaker's voice to a person's, or takes it out again (direction -1).
   * @param voiceId The person.
   * @param speaker The speaker.
   * @param direction 1 to add, -1 to take out.
   */
  private changeVoice(voiceId: number, speaker: VoiceSum, direction: 1 | -1): void {
    const voice = this.deps.store.getVoice(voiceId);
    if (!voice) {
      return;
    }
    addVoice(voice, { sum: speaker.sum.map((value) => value * direction), weight: speaker.weight * direction });
    // Nothing left of them (all taken back): an empty voice, not a negative one.
    const emptied = voice.weight <= 0;
    this.deps.store.saveVoice(voiceId, { sum: emptied ? new Float32Array(voice.sum.length) : voice.sum, weight: Math.max(0, voice.weight) }, this.deps.now());
  }
}

/**
 * A stretch's voiceprint, or null when the stretch holds too little audio to tell (e.g. a line running past the
 * end of the file).
 * @param printer The voice model.
 * @param samples The stretch.
 * @returns The voiceprint, or null.
 */
function voiceprintOf(printer: VoicePrinter, samples: Float32Array): Float32Array | null {
  if (samples.length < (MIN_VOICE_MS * SAMPLE_RATE) / 1000) {
    return null;
  }
  return printer.voiceprint(samples);
}
