import type { CallSpeaker, TranscriptLine } from "./ipc";

/** One speaker's turn: their lines in a row, joined. */
export interface Turn {
  side: "me" | "them";
  /** Which of the call's speakers ("them" only); null when unknown. */
  speakerId: number | null;
  start: number;
  text: string;
  /** The lines joined into it, in order. */
  lines: TranscriptLine[];
}

/** Who each side is, in the transcript. */
export const SIDE_NAMES = { me: "You", them: "Them" } as const;

/**
 * The name for your own voice heard on the other side (on some calls the Mac's sound carried your voice too, so
 * every line you said came twice). A speaker named this is shown as you, and their lines that repeat one from
 * your microphone are left out.
 */
export const YOUR_VOICE = SIDE_NAMES.me;

/**
 * Whether a call speaker is you.
 * @param speaker The speaker.
 * @returns True when named (or matched as) your own voice.
 */
export function isYou(speaker: Pick<CallSpeaker, "name"> | undefined): boolean {
  return speaker?.name?.toLowerCase() === YOUR_VOICE.toLowerCase();
}

/** A "me" line within this long of a "them" line can be the speakers heard by the microphone. */
const ECHO_WINDOW_MS = 4_000;

/** Share of a "me" line's words found in a nearby "them" line that marks it as an echo. */
const ECHO_OVERLAP = 0.6;

/** A "me" line shorter than this is never taken for an echo. */
const ECHO_MIN_WORDS = 4;

/**
 * Joins the lines each speaker said in a row into one turn, in the order they were said, leaving out your
 * microphone's echoes of the speakers, the lines you said weren't you, and the speakers' repeats of you.
 * @param lines The call's lines, in any order.
 * @param speakers The call's speakers.
 * @returns The turns.
 */
export function groupTurns(lines: TranscriptLine[], speakers: readonly CallSpeaker[] = []): Turn[] {
  const turns: Turn[] = [];
  const yours = lines.filter((line) => !line.notYou);
  for (const line of dropRepeatsOfYou(dropEchoes(yours), speakers).sort((a, b) => a.start - b.start)) {
    const last = turns.at(-1);
    if (last && last.side === line.side && last.speakerId === line.speakerId) {
      last.text = `${last.text} ${line.text}`;
      last.lines.push(line);
    } else {
      turns.push({ side: line.side, speakerId: line.speakerId, start: line.start, text: line.text, lines: [line] });
    }
  }
  return turns;
}

/**
 * Who said a turn, in words: "You", a name ("Dana", or "Dana?" when it's a guess), "Speaker 2", or "Them"
 * when the voice wasn't told apart.
 * @param turn The turn.
 * @param speakers The call's speakers.
 * @returns The label.
 */
export function speakerLabel(turn: Pick<Turn, "side" | "speakerId">, speakers: readonly CallSpeaker[]): string {
  if (turn.side === "me") {
    return SIDE_NAMES.me;
  }
  const speaker = speakers.find((each) => each.id === turn.speakerId);
  if (!speaker) {
    return SIDE_NAMES.them;
  }
  if (isYou(speaker) && speaker.sure) {
    return SIDE_NAMES.me;
  }
  if (speaker.name === null) {
    return `Speaker ${speaker.number}`;
  }
  return speaker.sure ? speaker.name : `${speaker.name}?`;
}

/**
 * Leaves out "me" lines that are the other people coming out of the speakers: without headphones your
 * microphone hears them too (seen in the 2026-11-09 live check, every "them" line repeated as "me"). A "me"
 * line is an echo when most of its words are in a "them" line said at about the same time.
 * @param lines The call's lines.
 * @returns The lines without the echoes.
 */
export function dropEchoes(lines: TranscriptLine[]): TranscriptLine[] {
  const theirs = theirWords(lines);
  return lines.filter((line) => {
    if (line.side !== "me") {
      return true;
    }
    // A short reply ("Yeah.", "Sounds good.") shares its words with plenty of lines; keep it.
    return wordsOf(line.text).size < ECHO_MIN_WORDS || !twinsATheirLine(line, theirs);
  });
}

/**
 * The lines from your microphone that are surely you: long enough to tell, and not repeated by a "them" line said
 * at about the same time (that's either the other people coming out of your speakers, or your own voice carried
 * to their side, and which it is can't be told from the words), and not one you said wasn't you.
 * @param lines The call's lines.
 * @returns Your own lines.
 */
export function yourOwnLines(lines: TranscriptLine[]): TranscriptLine[] {
  const theirs = theirWords(lines);
  return lines.filter(
    (line) => line.side === "me" && !line.notYou && wordsOf(line.text).size >= ECHO_MIN_WORDS && !twinsATheirLine(line, theirs),
  );
}

/**
 * Leaves out "them" lines in your own voice that repeat a line from your microphone said at about the same
 * time; one with no such twin (e.g. the microphone was off) stays, shown as you.
 * @param lines The call's lines.
 * @param speakers The call's speakers.
 * @returns The lines without the repeats.
 */
export function dropRepeatsOfYou(lines: TranscriptLine[], speakers: readonly CallSpeaker[]): TranscriptLine[] {
  const you = new Set(speakers.filter((speaker) => isYou(speaker) && speaker.sure).map((speaker) => speaker.id));
  if (you.size === 0) {
    return lines;
  }
  const mine = lines.filter((line) => line.side === "me");
  return lines.filter(
    (line) =>
      line.side === "me" ||
      line.speakerId === null ||
      !you.has(line.speakerId) ||
      !mine.some((own) => own.start < line.end + ECHO_WINDOW_MS && own.end > line.start - ECHO_WINDOW_MS),
  );
}

/**
 * The "them" lines of a call with their words, for finding the "me" lines they repeat.
 * @param lines The call's lines.
 * @returns Each "them" line and its words.
 */
function theirWords(lines: TranscriptLine[]): { line: TranscriptLine; words: Set<string> }[] {
  return lines.filter((line) => line.side === "them").map((line) => ({ line, words: wordsOf(line.text) }));
}

/**
 * Whether most of a "me" line's words are in a "them" line said at about the same time.
 * @param line The "me" line.
 * @param theirs The "them" lines with their words.
 * @returns True when one repeats it.
 */
function twinsATheirLine(line: TranscriptLine, theirs: { line: TranscriptLine; words: Set<string> }[]): boolean {
  const mine = [...wordsOf(line.text)];
  return theirs.some(({ line: their, words }) => {
    const near = line.start < their.end + ECHO_WINDOW_MS && line.end > their.start - ECHO_WINDOW_MS;
    return near && mine.filter((word) => words.has(word)).length / mine.length >= ECHO_OVERLAP;
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
 * Writes a call's transcript as plain text for the clipboard and for Claude: "9:31 AM Dana: …", one turn per
 * line.
 * @param lines The call's lines.
 * @param speakers The call's speakers.
 * @returns The text.
 */
export function transcriptText(lines: TranscriptLine[], speakers: readonly CallSpeaker[] = []): string {
  return groupTurns(lines, speakers)
    .map((turn) => `${formatClock(turn.start)} ${speakerLabel(turn, speakers)}: ${turn.text}`)
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
