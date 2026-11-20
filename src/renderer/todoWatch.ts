/**
 * Says what's wrong when the TODO board shows fewer items than the screen holds — the "everything vanished in the
 * middle of a meeting" case, written down so its cause can be found.
 * @param held Items still to do that the screen holds.
 * @param drawn Rows on the board.
 * @param visible Rows on the board that take up any room on screen.
 * @returns A line for the log, or null when the board shows them all.
 */
export function describeMissingRows(held: number, drawn: number, visible: number): string | null {
  if (held === 0 || (drawn >= held && visible >= held)) {
    return null;
  }
  if (drawn < held) {
    return `The board drew ${drawn} of the ${held} open items it holds.`;
  }
  return `The board drew all ${held} open items, but only ${visible} take up any room on screen.`;
}

/**
 * Says what's wrong when a change answered with an empty list though items were showing.
 * @param before How many items were showing.
 * @param after How many the change answered with.
 * @returns A line for the log, or null when that isn't what happened.
 */
export function describeEmptiedList(before: number, after: number): string | null {
  return before > 0 && after === 0 ? `A change answered with no items; ${before} were showing.` : null;
}
