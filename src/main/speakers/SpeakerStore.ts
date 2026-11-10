import type { DatabaseSync } from "node:sqlite";
import type { TranscriptLine } from "../../shared/ipc";
import { unit, type KnownVoice, type VoiceSum } from "./speakerMath";

/** One voice heard on the other side of a call. */
export interface StoredSpeaker extends VoiceSum {
  id: number;
  recordingId: number;
  /** "Speaker 1", "Speaker 2"… in the order they first spoke. */
  number: number;
  /** Who it is, when you said or a named voice matched; null when unknown. */
  voiceId: number | null;
  /** How close the match was; null when you named them yourself or there's no match. */
  voiceScore: number | null;
  /** Whether you named or confirmed them (never changed by matching). */
  confirmed: boolean;
  /** What they added to the person's voice when you named them; null when nothing was. */
  named: VoiceSum | null;
}

/** A named person, with their voice so far. */
export interface StoredVoice extends VoiceSum {
  id: number;
  name: string;
}

/** A line from the other side of a call, as splitting voices needs it. */
export interface TheirLine {
  id: number;
  start: number;
  end: number;
  speakerId: number | null;
}

/**
 * Where splitting a call's voices stands: split as it was transcribed ("live"), final ("done"), to be split
 * again from its audio file after a problem mid-call ("redo"), or couldn't be split ("failed").
 */
export type SpeakersState = "live" | "done" | "redo" | "failed";

/** The voices and call_speakers tables, and the speaker columns of recordings and transcript_lines (migration 14). */
export class SpeakerStore {
  /** @param db The open database. */
  constructor(private readonly db: DatabaseSync) {}

  /**
   * A call's speakers.
   * @param recordingId The call.
   * @returns Them, by number.
   */
  listSpeakers(recordingId: number): StoredSpeaker[] {
    const rows = this.db.prepare("SELECT * FROM call_speakers WHERE recording_id = ? ORDER BY number").all(recordingId);
    return rows.map((row) => mapSpeaker(row as Record<string, unknown>));
  }

  /**
   * Every speaker you haven't named or confirmed, in any call, for matching again when a voice changes.
   * @returns Them.
   */
  listUnconfirmedSpeakers(): StoredSpeaker[] {
    const rows = this.db.prepare("SELECT * FROM call_speakers WHERE confirmed = 0").all();
    return rows.map((row) => mapSpeaker(row as Record<string, unknown>));
  }

  /**
   * Finds one speaker.
   * @param id Its id.
   * @returns It, or null.
   */
  getSpeaker(id: number): StoredSpeaker | null {
    const row = this.db.prepare("SELECT * FROM call_speakers WHERE id = ?").get(id);
    return row ? mapSpeaker(row as Record<string, unknown>) : null;
  }

  /**
   * Adds the next speaker of a call.
   * @param recordingId The call.
   * @param voice Their first line's voice.
   * @returns The new speaker.
   */
  addSpeaker(recordingId: number, voice: VoiceSum): StoredSpeaker {
    const next = this.db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM call_speakers WHERE recording_id = ?").get(recordingId) as { n: number };
    const result = this.db
      .prepare("INSERT INTO call_speakers (recording_id, number, embedding, weight) VALUES (?, ?, ?, ?)")
      .run(recordingId, Number(next.n), blob(voice.sum), voice.weight);
    return this.getSpeaker(Number(result.lastInsertRowid)) as StoredSpeaker;
  }

  /**
   * Saves a speaker's voice after more lines went into it.
   * @param id The speaker.
   * @param voice Its voice now.
   */
  saveSpeakerVoice(id: number, voice: VoiceSum): void {
    this.db.prepare("UPDATE call_speakers SET embedding = ?, weight = ? WHERE id = ?").run(blob(voice.sum), voice.weight, id);
  }

  /**
   * Records who a speaker probably is, unless you've already said.
   * @param id The speaker.
   * @param voiceId The named voice, or null for nobody.
   * @param score How close.
   */
  setMatch(id: number, voiceId: number | null, score: number | null): void {
    this.db.prepare("UPDATE call_speakers SET voice_id = ?, voice_score = ? WHERE id = ? AND confirmed = 0").run(voiceId, score, id);
  }

  /**
   * Records who a speaker is, as you said, or (voiceId null) that it's nobody named so far ("Not Dana"),
   * which matching then leaves alone.
   * @param id The speaker.
   * @param voiceId The named voice, or null.
   * @param named What the speaker added to that voice, or null for nothing.
   */
  setConfirmed(id: number, voiceId: number | null, named: VoiceSum | null): void {
    this.db
      .prepare("UPDATE call_speakers SET voice_id = ?, voice_score = NULL, confirmed = 1, named_embedding = ?, named_weight = ? WHERE id = ?")
      .run(voiceId, named ? blob(named.sum) : null, named?.weight ?? null, id);
  }

  /**
   * Puts the lines of some speakers under another of the same call and deletes them, then numbers the call's
   * speakers 1, 2, 3… again in the order they first spoke.
   * @param keep The speaker that stays, with the merged voice.
   * @param folded The speakers merged into it.
   */
  mergeSpeakers(keep: StoredSpeaker, folded: StoredSpeaker[]): void {
    this.transaction(() => {
      for (const speaker of folded) {
        this.db.prepare("UPDATE transcript_lines SET speaker_id = ? WHERE speaker_id = ?").run(keep.id, speaker.id);
        this.db.prepare("DELETE FROM call_speakers WHERE id = ?").run(speaker.id);
      }
      this.saveSpeakerVoice(keep.id, keep);
      this.renumber(keep.recordingId);
    });
  }

  /**
   * Lines from the other side of a call.
   * @param recordingId The call.
   * @returns Them, in the order they were said.
   */
  listTheirLines(recordingId: number): TheirLine[] {
    const rows = this.db
      .prepare("SELECT id, started_at, ended_at, speaker_id FROM transcript_lines WHERE recording_id = ? AND side = 'them' ORDER BY started_at, id")
      .all(recordingId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id),
      start: Date.parse(String(row.started_at)),
      end: Date.parse(String(row.ended_at)),
      speakerId: row.speaker_id === null ? null : Number(row.speaker_id),
    }));
  }

  /**
   * Says who said a line.
   * @param lineId The line.
   * @param speakerId The speaker, or null.
   */
  setLineSpeaker(lineId: number, speakerId: number | null): void {
    this.db.prepare("UPDATE transcript_lines SET speaker_id = ? WHERE id = ?").run(speakerId, lineId);
  }

  /**
   * Where splitting a call's voices stands.
   * @param recordingId The call.
   * @returns The state, or null when it hasn't started.
   */
  getState(recordingId: number): SpeakersState | null {
    const row = this.db.prepare("SELECT speakers_state FROM recordings WHERE id = ?").get(recordingId) as { speakers_state: string | null } | undefined;
    return (row?.speakers_state ?? null) as SpeakersState | null;
  }

  /**
   * Records where splitting a call's voices stands.
   * @param recordingId The call.
   * @param state The state.
   */
  setState(recordingId: number, state: SpeakersState): void {
    this.db.prepare("UPDATE recordings SET speakers_state = ? WHERE id = ?").run(state, recordingId);
  }

  /**
   * The ended calls whose voices aren't final: split live and waiting to be tidied, never split (recorded
   * before this), or to be split again; newest first.
   * @returns Their ids, named audio files and states; a call with no named file yet is left for later.
   */
  listToSplit(): { id: number; audioPath: string; state: SpeakersState | null }[] {
    const rows = this.db
      .prepare(
        `SELECT id, audio_path, speakers_state FROM recordings
         WHERE ended_at IS NOT NULL AND audio_deleted_at IS NULL AND audio_path IS NOT NULL
           AND (speakers_state IS NULL OR speakers_state IN ('live', 'redo'))
         ORDER BY started_at DESC`,
      )
      .all() as { id: number; audio_path: string; speakers_state: string | null }[];
    return rows.map((row) => ({ id: Number(row.id), audioPath: String(row.audio_path), state: row.speakers_state as SpeakersState | null }));
  }

  /**
   * The finished calls your voice hasn't been learned from yet, newest first.
   * @returns Their ids and named audio files.
   */
  listToLearnYourVoice(): { id: number; audioPath: string }[] {
    const rows = this.db
      .prepare(
        `SELECT id, audio_path FROM recordings
         WHERE ended_at IS NOT NULL AND audio_deleted_at IS NULL AND audio_path IS NOT NULL
           AND speakers_state = 'done' AND your_voice_learned_at IS NULL
         ORDER BY started_at DESC`,
      )
      .all() as { id: number; audio_path: string }[];
    return rows.map((row) => ({ id: Number(row.id), audioPath: String(row.audio_path) }));
  }

  /**
   * Records that your voice was learned from a call (or that it couldn't be), so it's never counted twice.
   * @param recordingId The call.
   * @param now When.
   */
  setYourVoiceLearned(recordingId: number, now: number): void {
    this.db.prepare("UPDATE recordings SET your_voice_learned_at = ? WHERE id = ?").run(new Date(now).toISOString(), recordingId);
  }

  /**
   * Every line of a call, both sides.
   * @param recordingId The call.
   * @returns Them, in the order they were said.
   */
  listCallLines(recordingId: number): TranscriptLine[] {
    const rows = this.db
      .prepare("SELECT side, started_at, ended_at, text, speaker_id FROM transcript_lines WHERE recording_id = ? ORDER BY started_at, id")
      .all(recordingId) as Record<string, unknown>[];
    return rows.map((row) => ({
      side: row.side === "me" ? "me" : "them",
      start: Date.parse(String(row.started_at)),
      end: Date.parse(String(row.ended_at)),
      text: String(row.text),
      speakerId: row.speaker_id === null ? null : Number(row.speaker_id),
    }));
  }

  /**
   * Forgets a call's speakers, to split it again from the start.
   * @param recordingId The call.
   */
  clearSpeakers(recordingId: number): void {
    this.transaction(() => {
      this.db.prepare("UPDATE transcript_lines SET speaker_id = NULL WHERE recording_id = ?").run(recordingId);
      this.db.prepare("DELETE FROM call_speakers WHERE recording_id = ?").run(recordingId);
    });
  }

  /**
   * Everyone named so far.
   * @returns Them, by name.
   */
  listVoices(): StoredVoice[] {
    const rows = this.db.prepare("SELECT * FROM voices ORDER BY name").all();
    return rows.map((row) => mapVoice(row as Record<string, unknown>));
  }

  /**
   * Everyone named so far, as matching needs them.
   * @returns Their unit-length voices.
   */
  knownVoices(): KnownVoice[] {
    return this.listVoices().map((voice) => ({ id: voice.id, name: voice.name, embedding: unit(voice.sum) }));
  }

  /**
   * How many calls each person is in (named by you, or matched).
   * @returns Person id → calls.
   */
  countCallsByVoice(): Map<number, number> {
    const rows = this.db
      .prepare("SELECT voice_id, COUNT(DISTINCT recording_id) AS calls FROM call_speakers WHERE voice_id IS NOT NULL GROUP BY voice_id")
      .all() as { voice_id: number; calls: number }[];
    return new Map(rows.map((row) => [Number(row.voice_id), Number(row.calls)]));
  }

  /**
   * Finds a named person.
   * @param name Their name (case ignored).
   * @returns Them, or null.
   */
  findVoice(name: string): StoredVoice | null {
    const row = this.db.prepare("SELECT * FROM voices WHERE name = ?").get(name);
    return row ? mapVoice(row as Record<string, unknown>) : null;
  }

  /**
   * Finds a named person.
   * @param id Their id.
   * @returns Them, or null.
   */
  getVoice(id: number): StoredVoice | null {
    const row = this.db.prepare("SELECT * FROM voices WHERE id = ?").get(id);
    return row ? mapVoice(row as Record<string, unknown>) : null;
  }

  /**
   * Adds a named person.
   * @param name Their name.
   * @param voice Their voice.
   * @param now The time.
   * @returns Their id.
   */
  addVoice(name: string, voice: VoiceSum, now: number): number {
    const at = new Date(now).toISOString();
    const result = this.db
      .prepare("INSERT INTO voices (name, embedding, weight, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(name, blob(voice.sum), voice.weight, at, at);
    return Number(result.lastInsertRowid);
  }

  /**
   * Saves a person's voice after another call went into it.
   * @param id The person.
   * @param voice Their voice now.
   * @param now The time.
   */
  saveVoice(id: number, voice: VoiceSum, now: number): void {
    this.db
      .prepare("UPDATE voices SET embedding = ?, weight = ?, updated_at = ? WHERE id = ?")
      .run(blob(voice.sum), voice.weight, new Date(now).toISOString(), id);
  }

  /**
   * Renames a person.
   * @param id The person.
   * @param name The new name.
   */
  renameVoice(id: number, name: string): void {
    this.db.prepare("UPDATE voices SET name = ? WHERE id = ?").run(name, id);
  }

  /**
   * Forgets a person and their voice. The speakers you named as them lose their voiceprints too (zeroed, and
   * never matched again), since each is that person's voice in one call; ones only matched to them go back to
   * "Speaker N" and may match someone else.
   * @param id The person.
   */
  deleteVoice(id: number): void {
    this.transaction(() => {
      const named = this.db.prepare("SELECT id, embedding FROM call_speakers WHERE voice_id = ? AND confirmed = 1").all(id) as { id: number; embedding: Uint8Array }[];
      for (const row of named) {
        this.db
          .prepare("UPDATE call_speakers SET embedding = ?, weight = 0, voice_id = NULL, voice_score = NULL, named_embedding = NULL, named_weight = NULL WHERE id = ?")
          .run(new Uint8Array(row.embedding.byteLength), Number(row.id));
      }
      this.db.prepare("UPDATE call_speakers SET voice_id = NULL, voice_score = NULL WHERE voice_id = ?").run(id);
      this.db.prepare("DELETE FROM voices WHERE id = ?").run(id);
    });
  }

  /**
   * Numbers a call's speakers 1, 2, 3… in the order they first spoke.
   * @param recordingId The call.
   */
  private renumber(recordingId: number): void {
    const rows = this.db
      .prepare(
        `SELECT s.id FROM call_speakers s
         LEFT JOIN transcript_lines l ON l.speaker_id = s.id
         WHERE s.recording_id = ? GROUP BY s.id ORDER BY MIN(l.started_at) IS NULL, MIN(l.started_at), s.number`,
      )
      .all(recordingId) as { id: number }[];
    // Out of the way first: (recording_id, number) is unique.
    this.db.prepare("UPDATE call_speakers SET number = -number WHERE recording_id = ?").run(recordingId);
    rows.forEach((row, index) => this.db.prepare("UPDATE call_speakers SET number = ? WHERE id = ?").run(index + 1, Number(row.id)));
  }

  /**
   * Runs some writes all together or not at all.
   * @param work The writes.
   */
  private transaction(work: () => void): void {
    this.db.exec("BEGIN");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

/**
 * Maps a call_speakers row.
 * @param row The row.
 * @returns The speaker.
 */
function mapSpeaker(row: Record<string, unknown>): StoredSpeaker {
  return {
    id: Number(row.id),
    recordingId: Number(row.recording_id),
    number: Number(row.number),
    sum: floats(row.embedding),
    weight: Number(row.weight),
    voiceId: row.voice_id === null || row.voice_id === undefined ? null : Number(row.voice_id),
    voiceScore: row.voice_score === null || row.voice_score === undefined ? null : Number(row.voice_score),
    confirmed: Number(row.confirmed) === 1,
    named:
      row.named_embedding === null || row.named_embedding === undefined
        ? null
        : { sum: floats(row.named_embedding), weight: Number(row.named_weight) },
  };
}

/**
 * Maps a voices row.
 * @param row The row.
 * @returns The person.
 */
function mapVoice(row: Record<string, unknown>): StoredVoice {
  return { id: Number(row.id), name: String(row.name), sum: floats(row.embedding), weight: Number(row.weight) };
}

/**
 * A voice as stored: its float32 numbers' bytes.
 * @param vector The voice.
 * @returns The bytes.
 */
function blob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

/**
 * A stored voice back as numbers.
 * @param value The BLOB.
 * @returns A copy as float32.
 */
function floats(value: unknown): Float32Array {
  const bytes = value as Uint8Array;
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
