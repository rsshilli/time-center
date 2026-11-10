import { describeSpeakers, inviteeName, nameChoices } from "../../src/main/speakers/speakerIpc";
import type { StoredSpeaker } from "../../src/main/speakers/SpeakerStore";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

/**
 * A stored speaker with defaults.
 * @param fields What differs.
 * @returns The speaker.
 */
const speaker = (fields: Partial<StoredSpeaker>): StoredSpeaker => ({
  id: 1,
  recordingId: 1,
  number: 1,
  sum: new Float32Array(2),
  weight: 5,
  voiceId: null,
  voiceScore: null,
  confirmed: false,
  named: null,
  ...fields,
});

describe("describeSpeakers", () => {
  const names = new Map([[7, "Dana"]]);

  it("should show a speaker by name when you named them or the match is sure, as a guess otherwise", () => {
    expect(
      describeSpeakers(
        [
          speaker({ id: 1, number: 1, voiceId: 7, confirmed: true }),
          speaker({ id: 2, number: 2, voiceId: 7, voiceScore: 0.85 }),
          speaker({ id: 3, number: 3, voiceId: 7, voiceScore: 0.75 }),
          speaker({ id: 4, number: 4, voiceId: 7, voiceScore: 0.85, weight: 1 }),
          speaker({ id: 5, number: 5 }),
          speaker({ id: 6, number: 6, confirmed: true }),
        ],
        names,
      ),
    ).toEqual([
      { id: 1, number: 1, name: "Dana", sure: true },
      { id: 2, number: 2, name: "Dana", sure: true },
      { id: 3, number: 3, name: "Dana", sure: false },
      { id: 4, number: 4, name: "Dana", sure: false },
      { id: 5, number: 5, name: null, sure: false },
      { id: 6, number: 6, name: null, sure: false },
    ]);
  });
});

describe("nameChoices", () => {
  it("should offer the invitees first, then everyone named before, each name once", () => {
    const invitees = [
      { email: "paul.jones@qbdvision.com", name: null },
      { email: "dana@x.com", name: "Dana Smith" },
    ];
    expect(nameChoices(invitees, ["dana smith", "Yash"])).toEqual(["Paul Jones", "Dana Smith", "Yash"]);
  });
});

describe("inviteeName", () => {
  it("should use Google's name, or make one from the email address", () => {
    expect(inviteeName({ email: "x@y.z", name: "Chas" })).toBe("Chas");
    expect(inviteeName({ email: "mary-ann_lee@y.z", name: null })).toBe("Mary Ann Lee");
  });
});
