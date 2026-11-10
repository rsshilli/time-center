import {
  LINE_JOINS,
  addLine,
  matchVoice,
  pickSpeaker,
  samePersonGroups,
  strayHomes,
  unit,
  type VoiceSum,
} from "../../src/main/speakers/speakerMath";

/**
 * A voiceprint pointing mostly one way, with a little of another.
 * @param main The main direction (0–3).
 * @param other How much of direction 4 to mix in.
 * @returns The vector.
 */
const print = (main: number, other = 0): Float32Array => {
  const vector = new Float32Array(5);
  vector[main] = 1;
  vector[4] = other;
  return vector;
};

/**
 * A voice in the making from some voiceprints.
 * @param prints The lines' voiceprints.
 * @returns The voice.
 */
const voice = (...prints: Float32Array[]): VoiceSum => {
  const made = { sum: new Float32Array(5), weight: 0 };
  prints.forEach((each) => addLine(made, each));
  return made;
};

describe("pickSpeaker", () => {
  it("should join the closest speaker when the line sounds like them", () => {
    expect(pickSpeaker([voice(print(0)), voice(print(1))], print(1, 0.3), 3_000)).toEqual({ kind: "join", index: 1, score: expect.any(Number) });
  });

  it("should start a new speaker for a long line that sounds like nobody so far", () => {
    expect(pickSpeaker([voice(print(0))], print(2), 3_000)).toEqual({ kind: "new" });
    expect(pickSpeaker([], print(2), 3_000)).toEqual({ kind: "new" });
  });

  it("should never start a new speaker from a short line, joining a near-enough one or none", () => {
    expect(pickSpeaker([voice(print(0))], print(2), 1_000)).toEqual({ kind: "none" });
    // cos ≈ 0.32: under LINE_JOINS, over the short-line bar.
    const near = pickSpeaker([voice(print(0))], print(2, 0).map((value, index) => (index === 0 ? 0.34 : value)), 1_000);
    expect(near).toMatchObject({ kind: "join", index: 0 });
    expect(near.kind === "join" && near.score < LINE_JOINS).toBe(true);
  });
});

describe("matchVoice", () => {
  const voices = [
    { id: 7, name: "Dana", embedding: unit(print(0)) },
    { id: 8, name: "Eve", embedding: unit(print(1)) },
  ];

  it("should name a speaker heard enough who sounds like someone named", () => {
    const heard = Array.from({ length: 5 }, () => print(0, 0.2));
    expect(matchVoice(voice(...heard), voices)).toEqual({ voiceId: 7, score: expect.any(Number), sure: true });
    expect(matchVoice(voice(...heard.slice(1)), voices)).toMatchObject({ voiceId: 7, sure: false });
  });

  it("should only ask about a speaker heard once, however close", () => {
    expect(matchVoice(voice(print(0)), voices)).toMatchObject({ voiceId: 7, sure: false });
  });

  it("should ask, not name, when the voice is only fairly close", () => {
    // cos(e0 + 0.88·e4, e0) ≈ 0.75: between "maybe" and "sure".
    expect(matchVoice(voice(...Array.from({ length: 5 }, () => print(0, 0.88))), voices)).toMatchObject({ voiceId: 7, sure: false });
  });

  it("should match nobody when no one named sounds alike", () => {
    expect(matchVoice(voice(print(2), print(2), print(2)), voices)).toBeNull();
  });
});

describe("strayHomes", () => {
  it("should fold a speaker of a line or two into the closest real speaker, if close enough", () => {
    const real = [voice(print(0), print(0), print(0)), voice(print(1), print(1), print(1))];
    const strays = [voice(print(1, 0.5)), voice(print(2))];
    expect(strayHomes([...real, ...strays])).toEqual(new Map([[2, 1]]));
  });
});

describe("samePersonGroups", () => {
  it("should group speakers that sound alike, the first of each group first, and leave the rest out", () => {
    const speakers = [voice(print(0)), voice(print(1)), voice(print(0, 0.2)), voice(print(2)), voice(print(1, 0.1)), voice(print(0, 0.1))];
    expect(samePersonGroups(speakers)).toEqual([
      [0, 2, 5],
      [1, 4],
    ]);
  });
});
