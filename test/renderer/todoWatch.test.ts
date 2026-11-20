import { describeEmptiedList, describeMissingRows } from "../../src/renderer/todoWatch";

describe("describeMissingRows", () => {
  it("should say nothing when the board shows every open item, or there are none", () => {
    expect(describeMissingRows(25, 25, 25)).toBeNull();
    expect(describeMissingRows(0, 0, 0)).toBeNull();
  });

  it("should say how many rows were drawn when some are missing", () => {
    expect(describeMissingRows(25, 0, 0)).toBe("The board drew 0 of the 25 open items it holds.");
  });

  it("should say when every row is drawn but some take up no room", () => {
    expect(describeMissingRows(25, 25, 0)).toBe("The board drew all 25 open items, but only 0 take up any room on screen.");
  });
});

describe("describeEmptiedList", () => {
  it("should say when a change emptied a list that had items", () => {
    expect(describeEmptiedList(40, 0)).toBe("A change answered with no items; 40 were showing.");
  });

  it("should say nothing when the list wasn't emptied", () => {
    expect(describeEmptiedList(40, 39)).toBeNull();
    expect(describeEmptiedList(0, 0)).toBeNull();
  });
});
