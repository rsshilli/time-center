import { pickJoinButton } from "../../extension/src/pickJoinButton";

/**
 * A button with one visible label.
 * @param label Its text.
 * @param disabled Whether it's greyed out.
 * @returns The candidate.
 */
const button = (label: string, disabled = false) => ({ labels: [label, ""], disabled });

describe("pickJoinButton", () => {
  it("should pick Meet's Join now button over everything else", () => {
    expect(pickJoinButton([button("Present"), button("Other ways to join"), button("  Join\n now ")])).toEqual({
      index: 2,
      joins: true,
    });
  });

  it("should pick Ask to join when someone has to let you in", () => {
    expect(pickJoinButton([button("Ask to join")])).toEqual({ index: 0, joins: true });
  });

  it("should match a button by its accessible name", () => {
    expect(pickJoinButton([{ labels: ["", "Join now"], disabled: false }])).toEqual({ index: 0, joins: true });
  });

  it("should step through Teams' launcher page to the browser", () => {
    expect(pickJoinButton([button("Download the Windows app"), button("Continue on this browser")])).toEqual({
      index: 1,
      joins: false,
    });
  });

  it("should pass over a greyed-out Join button and anything that only contains the words", () => {
    expect(pickJoinButton([button("Join now", true), button("Join now from another device")])).toBeNull();
  });
});
