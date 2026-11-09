import type { TranscriptLine } from "./ipc";

/** One speaker's turn: their lines in a row, joined. */
export interface Turn {
  side: "me" | "them";
  start: number;
  text: string;
}

/** Who each side is, in the transcript. */
export const SIDE_NAMES = { me: "You", them: "Them" } as const;

/** A "me" line within this long of a "them" line can be the speakers heard by the microphone. */
const ECHO_WINDOW_MS = 4_000;

/** Share of a "me" line's words found in a nearby "them" line that marks it as an echo. */
const ECHO_OVERLAP = 0.6;

/** A "me" line shorter than this is never taken for an echo. */
const ECHO_MIN_WORDS = 4;

/**
 * Joins the lines each side said in a row into one turn, in the order they were said, leaving out your
 * microphone's echoes of the speakers.
 * @param lines The call's lines, in any order.
 * @returns The turns.
 */
export function groupTurns(lines: TranscriptLine[]): Turn[] {
  const turns: Turn[] = [];
  for (const line of dropEchoes(lines).sort((a, b) => a.start - b.start)) {
    const last = turns.at(-1);
    if (last && last.side === line.side) {
      last.text = `${last.text} ${line.text}`;
    } else {
      turns.push({ side: line.side, start: line.start, text: line.text });
    }
  }
  return turns;
}

/**
 * Leaves out "me" lines that are the other people coming out of the speakers: without headphones your
 * microphone hears them too (seen in the 2026-11-09 live check, every "them" line repeated as "me"). A "me"
 * line is an echo when most of its words are in a "them" line said at about the same time.
 * @param lines The call's lines.
 * @returns The lines without the echoes.
 */
export function dropEchoes(lines: TranscriptLine[]): TranscriptLine[] {
  const theirs = lines.filter((line) => line.side === "them").map((line) => ({ line, words: wordsOf(line.text) }));
  return lines.filter((line) => {
    if (line.side !== "me") {
      return true;
    }
    const mine = [...wordsOf(line.text)];
    // A short reply ("Yeah.", "Sounds good.") shares its words with plenty of lines; keep it.
    if (mine.length < ECHO_MIN_WORDS) {
      return true;
    }
    return !theirs.some(({ line: their, words }) => {
      const near = line.start < their.end + ECHO_WINDOW_MS && line.end > their.start - ECHO_WINDOW_MS;
      return near && mine.filter((word) => words.has(word)).length / mine.length >= ECHO_OVERLAP;
    });
  });
}

/**
 * The words of a line, lower-cased, without punctuation.
 * @param text The line.
 * @returns Its distinct words.
 */
function wordsOf(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []);
}

/**
 * Writes a call's transcript as plain text for the clipboard: "9:31 AM You: …", one turn per line.
 * @param lines The call's lines.
 * @returns The text.
 */
export function transcriptText(lines: TranscriptLine[]): string {
  return groupTurns(lines)
    .map((turn) => `${formatClock(turn.start)} ${SIDE_NAMES[turn.side]}: ${turn.text}`)
    .join("\n");
}

/**
 * Writes a time of day the short way.
 * @param ms The moment.
 * @returns e.g. "9:30 AM".
 */
export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
