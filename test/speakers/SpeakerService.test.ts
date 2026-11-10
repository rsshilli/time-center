import { RecordingStore } from "../../src/main/recording/RecordingStore";
import { SpeakerService, type SpeakerServiceDeps } from "../../src/main/speakers/SpeakerService";
import { SpeakerStore } from "../../src/main/speakers/SpeakerStore";
import { SAMPLE_RATE } from "../../src/main/speakers/wavSamples";
import { Store } from "../../src/main/store/Store";

const T0 = Date.UTC(2026, 10, 10, 14);

/** A line: who said it (1–4, coded into its audio), and when, in seconds after T0. */
type Said = [who: number, from: number, to: number];

/**
 * Audio where each line's stretch holds its speaker's code (who / 10) and the rest is silence.
 * @param lines The lines.
 * @param origin The moment the audio starts at.
 * @returns The samples.
 */
function audio(lines: Said[], origin: number): Float32Array {
  const end = Math.max(...lines.map(([, , to]) => to));
  const samples = new Float32Array(Math.ceil((end + 1 - (origin - T0) / 1000) * SAMPLE_RATE));
  for (const [who, from, to] of lines) {
    // Clamped: a negative index would count from the end.
    const at = (seconds: number) => Math.max(0, Math.round((seconds - (origin - T0) / 1000) * SAMPLE_RATE));
    samples.fill(who / 10, at(from), at(to));
  }
  return samples;
}

/**
 * A fake voice model: the voiceprint of a stretch points the way of the speaker coded in its middle sample.
 * @param samples A line's samples.
 * @returns Its voiceprint.
 */
function voiceprint(samples: Float32Array): Float32Array {
  const vector = new Float32Array(6).fill(0.05);
  vector[Math.round(samples[samples.length >> 1] * 10)] = 1;
  return vector;
}

describe("SpeakerService", () => {
  let store: Store;
  let recordings: RecordingStore;
  let speakers: SpeakerStore;
  let deps: SpeakerServiceDeps;
  let service: SpeakerService;
  let chunkAudio: Float32Array;
  let callAudio: Float32Array;

  beforeEach(async () => {
    store = new Store(":memory:");
    recordings = new RecordingStore(store.db);
    speakers = new SpeakerStore(store.db);
    deps = {
      store: speakers,
      loadPrinter: async () => ({ voiceprint }),
      readChunk: async () => chunkAudio,
      readCall: async () => callAudio,
      recordingStart: (id) => recordings.getRecording(id)?.start ?? null,
      stillTranscribing: () => false,
      isRecording: () => false,
      yieldNow: async () => {},
      now: () => T0,
      log: () => {},
    };
    service = new SpeakerService(deps);
    await service.prepareAhead();
  });

  afterEach(() => {
    store.close();
  });

  /**
   * Stores a call's "them" lines as one chunk, as the transcriber would, and hands them to the service.
   * @param lines The lines.
   * @param start When the call started.
   * @returns The call's id.
   */
  async function liveCall(lines: Said[], start = T0): Promise<number> {
    const id = recordings.insertRecording(start, "/r");
    const stored = lines.map(([, from, to], index) => ({ side: "them" as const, start: T0 + from * 1000, end: T0 + to * 1000, text: `line ${index}` }));
    const ids = recordings.insertLines(id, stored);
    chunkAudio = audio(lines, T0);
    await service.chunkTranscribed(id, { wav: "/them.wav", side: "them", t0: T0 }, stored.map((line, index) => ({ id: ids[index], start: line.start, end: line.end, speakerId: null })));
    return id;
  }

  /**
   * Who said each line of a call, as speaker numbers.
   * @param id The call.
   * @returns One number (or null) per line.
   */
  function numbers(id: number): (number | null)[] {
    const byId = new Map(speakers.listSpeakers(id).map((speaker) => [speaker.id, speaker.number]));
    return recordings.listLines(id).map((line) => (line.speakerId === null ? null : (byId.get(line.speakerId) ?? null)));
  }

  it("should number voices in the order they first speak and give each line its speaker", async () => {
    const id = await liveCall([
      [2, 0, 3],
      [1, 4, 7],
      [1, 7.2, 7.6], // too short to tell: the speaker before it
      [2, 8, 11],
      [3, 20, 20.5], // too short, and long after the last line: nobody
    ]);
    expect(numbers(id)).toEqual([1, 2, 2, 1, null]);
    expect(speakers.getState(id)).toBe("live");
  });

  it("should recognize someone you named in a later call, by name once heard enough", async () => {
    const first = await liveCall([[1, 0, 3]]);
    service.nameSpeaker(speakers.listSpeakers(first)[0].id, "  Dana   Smith ");
    const later = await liveCall([
      [1, 0, 3],
      [2, 4, 7],
      [1, 8, 11],
      [1, 12, 15],
    ]);
    const [dana, other] = speakers.listSpeakers(later);
    expect(speakers.getVoice(dana.voiceId as number)?.name).toBe("Dana Smith");
    expect(dana).toMatchObject({ confirmed: false, weight: 3 });
    expect(other.voiceId).toBeNull();
  });

  it("should take a speaker's voice back out of a person when you name them as someone else", async () => {
    const id = await liveCall([[1, 0, 3]]);
    const speaker = speakers.listSpeakers(id)[0];
    service.nameSpeaker(speaker.id, "Dana");
    service.nameSpeaker(speaker.id, "eve");
    expect(speakers.findVoice("Dana")?.weight).toBe(0);
    expect(speakers.findVoice("Eve")?.weight).toBe(1);
    service.nameSpeaker(speaker.id, null);
    expect(speakers.getSpeaker(speaker.id)).toMatchObject({ voiceId: null, confirmed: true });
    expect(speakers.findVoice("eve")?.weight).toBe(0);
  });

  it("should never guess a name again for a speaker you said isn't them", async () => {
    const first = await liveCall([[1, 0, 3]]);
    service.nameSpeaker(speakers.listSpeakers(first)[0].id, "Dana");
    const later = await liveCall([[1, 0, 3]]);
    const guess = speakers.listSpeakers(later)[0];
    expect(guess).toMatchObject({ voiceId: speakers.findVoice("Dana")?.id, confirmed: false });
    service.nameSpeaker(guess.id, null);
    service.nameSpeaker(speakers.listSpeakers(first)[0].id, "Dana");
    expect(speakers.getSpeaker(guess.id)).toMatchObject({ voiceId: null, confirmed: true });
  });

  it("should refuse an empty or overlong name", async () => {
    const id = await liveCall([[1, 0, 3]]);
    const speaker = speakers.listSpeakers(id)[0];
    expect(() => service.nameSpeaker(speaker.id, "   ")).toThrow("A name can be 1 to 80 characters.");
    expect(() => service.nameSpeaker(speaker.id, "x".repeat(81))).toThrow("A name can be 1 to 80 characters.");
  });

  it("should merge speakers that turn out to be one person when the call is finished, renumbering them", async () => {
    const id = await liveCall([
      [3, 0, 3],
      [1, 4, 7],
    ]);
    // A third speaker the live pass split off, sounding like Speaker 2.
    const extra = speakers.addSpeaker(id, { sum: voiceprint(new Float32Array([0.1])), weight: 1 });
    const [line] = recordings.insertLines(id, [{ side: "them", start: T0 + 1_000, end: T0 + 2_000, text: "early" }]);
    speakers.setLineSpeaker(line, extra.id);
    recordings.finishRecording(id, T0 + 60_000);
    recordings.setAudioPath(id, "/call.m4a");
    await service.catchUp();
    expect(speakers.listSpeakers(id).map((speaker) => [speaker.number, speaker.weight])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(numbers(id)).toEqual([1, 2, 2]);
    expect(speakers.getState(id)).toBe("done");
  });

  it("should split a call recorded before speakers existed from its audio file, keeping names you gave", async () => {
    const id = recordings.insertRecording(T0, "/r");
    const said: Said[] = [
      [2, 0, 3],
      [1, 4, 7],
      [2, 8, 11],
    ];
    const lineIds = recordings.insertLines(
      id,
      said.map(([, from, to]) => ({ side: "them", start: T0 + from * 1000, end: T0 + to * 1000, text: "x" })),
    );
    recordings.insertLines(id, [{ side: "me", start: T0 + 12_000, end: T0 + 14_000, text: "mine" }]);
    // Named once already (e.g. split before, then the app quit mid-call).
    const before = speakers.addSpeaker(id, { sum: voiceprint(new Float32Array([0.2])), weight: 1 });
    speakers.setLineSpeaker(lineIds[0], before.id);
    service.nameSpeaker(before.id, "Dana");
    speakers.setState(id, "redo");
    recordings.finishRecording(id, T0 + 60_000);
    recordings.setAudioPath(id, "/call.m4a");
    // The file starts 0.4 s after the recording did.
    callAudio = audio(said, T0 + 400);
    await service.catchUp();
    expect(numbers(id)).toEqual([1, 2, 1, null]);
    const [dana, other] = speakers.listSpeakers(id);
    expect(dana).toMatchObject({ confirmed: true, voiceId: speakers.findVoice("Dana")?.id });
    expect(other.voiceId).toBeNull();
    expect(speakers.getState(id)).toBe("done");
  });

  it("should mark a call to be split again from its file when a chunk can't be read", async () => {
    deps.readChunk = async () => {
      throw new Error("gone");
    };
    const id = await liveCall([[1, 0, 3]]);
    expect(speakers.getState(id)).toBe("redo");
  });

  it("should leave calls as they are while the voice model can't be loaded, to try again later", async () => {
    const offline = new SpeakerService({
      ...deps,
      loadPrinter: async () => {
        throw new Error("offline");
      },
    });
    const id = recordings.insertRecording(T0, "/r");
    recordings.finishRecording(id, T0 + 60_000);
    recordings.setAudioPath(id, "/call.m4a");
    await offline.catchUp();
    expect(speakers.getState(id)).toBeNull();
  });

  it("should leave a call alone while its chunks are still being transcribed, and all calls while recording", async () => {
    const id = await liveCall([[1, 0, 3]]);
    recordings.finishRecording(id, T0 + 60_000);
    recordings.setAudioPath(id, "/call.m4a");
    deps.stillTranscribing = () => true;
    await service.catchUp();
    expect(speakers.getState(id)).toBe("live");
    deps.stillTranscribing = () => false;
    deps.isRecording = () => true;
    await service.catchUp();
    expect(speakers.getState(id)).toBe("live");
  });

  it("should forget a person and wipe the voiceprints of the speakers you named as them", async () => {
    const id = await liveCall([[1, 0, 3]]);
    const speaker = speakers.listSpeakers(id)[0];
    service.nameSpeaker(speaker.id, "Dana");
    service.forgetVoice(speakers.findVoice("Dana")?.id as number);
    const after = speakers.getSpeaker(speaker.id);
    expect(after).toMatchObject({ voiceId: null, confirmed: true, weight: 0, named: null });
    expect([...(after?.sum ?? [])].every((value) => value === 0)).toBe(true);
    expect(speakers.listVoices()).toEqual([]);
  });

  it("should take back only what a speaker added when named, even after they grew", async () => {
    const first = await liveCall([[1, 0, 3]]);
    service.nameSpeaker(speakers.listSpeakers(first)[0].id, "Dana");
    const second = await liveCall([[1, 0, 3]]);
    const speaker = speakers.listSpeakers(second)[0];
    service.nameSpeaker(speaker.id, "Dana");
    expect(speakers.findVoice("Dana")?.weight).toBe(2);
    // The call goes on: three more lines join the speaker after you named them.
    const ids = recordings.insertLines(second, [4, 8, 12].map((at) => ({ side: "them" as const, start: T0 + at * 1000, end: T0 + (at + 3) * 1000, text: "x" })));
    chunkAudio = audio([[1, 0, 16]], T0);
    await service.chunkTranscribed(second, { wav: "/them.wav", side: "them", t0: T0 }, ids.map((lineId, index) => ({ id: lineId, start: T0 + [4, 8, 12][index] * 1000, end: T0 + ([4, 8, 12][index] + 3) * 1000, speakerId: null })));
    expect(speakers.getSpeaker(speaker.id)?.weight).toBe(4);
    service.nameSpeaker(speaker.id, "Pat");
    const dana = speakers.findVoice("Dana");
    expect(dana?.weight).toBe(1);
    expect(Math.min(...(dana?.sum ?? []))).toBeGreaterThanOrEqual(0);
  });

  it("should never hold up a chunk while the voice model is still loading, splitting the call from its file later", async () => {
    const fresh = new SpeakerService({ ...deps, loadPrinter: () => new Promise(() => {}) });
    const id = recordings.insertRecording(T0, "/r");
    const [lineId] = recordings.insertLines(id, [{ side: "them", start: T0, end: T0 + 3_000, text: "x" }]);
    await fresh.chunkTranscribed(id, { wav: "/them.wav", side: "them", t0: T0 }, [{ id: lineId, start: T0, end: T0 + 3_000, speakerId: null }]);
    expect(speakers.getState(id)).toBe("redo");
  });

  it("should keep the names you gave when a line runs past the end of the audio file", async () => {
    const id = recordings.insertRecording(T0, "/r");
    const said: Said[] = [
      [2, 0, 3],
      [1, 4, 7],
    ];
    const lineIds = recordings.insertLines(
      id,
      [...said, [1, 30, 34] as Said].map(([, from, to]) => ({ side: "them", start: T0 + from * 1000, end: T0 + to * 1000, text: "x" })),
    );
    const before = speakers.addSpeaker(id, { sum: voiceprint(new Float32Array([0.2])), weight: 1 });
    speakers.setLineSpeaker(lineIds[0], before.id);
    service.nameSpeaker(before.id, "Dana");
    speakers.setState(id, "redo");
    recordings.finishRecording(id, T0 + 60_000);
    recordings.setAudioPath(id, "/call.m4a");
    callAudio = audio(said, T0);
    await service.catchUp();
    expect(speakers.getState(id)).toBe("done");
    expect(speakers.listSpeakers(id).find((speaker) => speaker.confirmed)?.voiceId).toBe(speakers.findVoice("Dana")?.id);
  });

  it("should learn your voice from your microphone once a call is finished, and know you on their side", async () => {
    const id = recordings.insertRecording(T0, "/r");
    // Their side: your voice (1) carried over five times, then someone else (2) five times.
    const theirs: Said[] = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36].map((from, index) => [index < 5 ? 1 : 2, from, from + 3]);
    // Your microphone: two lines only you said, and one repeating the other person (coming out of your speakers).
    const yours: Said[] = [
      [1, 40, 43],
      [1, 44, 47],
    ];
    recordings.insertLines(id, [
      ...theirs.map(([, from, to], index) => ({ side: "them" as const, start: T0 + from * 1000, end: T0 + to * 1000, text: `their line number ${index} today` })),
      ...yours.map(([, from, to], index) => ({ side: "me" as const, start: T0 + from * 1000, end: T0 + to * 1000, text: `my own line number ${index} here` })),
      { side: "me", start: T0 + 20_000, end: T0 + 23_000, text: "their line number 5 today" },
    ]);
    recordings.finishRecording(id, T0 + 60_000);
    recordings.setAudioPath(id, "/call.m4a");
    callAudio = audio([...theirs, ...yours], T0);

    await service.catchUp();

    const you = speakers.findVoice("You");
    expect(you?.weight).toBe(2);
    const [carried, other] = speakers.listSpeakers(id);
    expect(carried).toEqual(expect.objectContaining({ voiceId: you?.id, confirmed: false }));
    expect(carried.voiceScore).toBeGreaterThan(0.8);
    expect(other.voiceId).toBeNull();

    await service.catchUp();
    expect(speakers.findVoice("You")?.weight).toBe(2);
  });

  it("should try a call once when your voice can't be learned from it", async () => {
    const id = recordings.insertRecording(T0, "/r");
    recordings.insertLines(id, [{ side: "me", start: T0, end: T0 + 3_000, text: "my own line number one" }]);
    recordings.finishRecording(id, T0 + 60_000);
    recordings.setAudioPath(id, "/call.m4a");
    deps.readCall = async () => {
      throw new Error("gone");
    };

    await service.catchUp();

    expect(speakers.findVoice("You")).toBeNull();
    expect(speakers.listToLearnYourVoice()).toEqual([]);
  });
});
