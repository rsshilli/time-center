import { suggestionKey, visibleSuggestions } from "../../src/renderer/useDismissals";

const a = { recordingId: 1, saidAt: 10, text: "Send the keys" };
const b = { recordingId: 1, saidAt: 20, text: "Book the room" };

describe("visibleSuggestions", () => {
  it("should hide a suggestion just dismissed", () => {
    expect(visibleSuggestions([a, b], [], new Set([suggestionKey(a)]), suggestionKey)).toEqual([b]);
  });

  it("should show a suggestion Undo brought back after the reloaded list left it out", () => {
    expect(visibleSuggestions([b], [a], new Set(), suggestionKey)).toEqual([b, a]);
  });

  it("should show a restored suggestion once when the reloaded list has it again", () => {
    expect(visibleSuggestions([a, b], [{ ...a }], new Set(), suggestionKey)).toEqual([a, b]);
  });
});

describe("suggestionKey", () => {
  it("should differ when the call, the moment or the words differ", () => {
    const keys = new Set([a, { ...a, recordingId: 2 }, { ...a, saidAt: 11 }, { ...a, text: "Send the key" }].map(suggestionKey));
    expect(keys.size).toBe(4);
  });
});
