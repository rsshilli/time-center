import { CALL_FINISHING_MS, type ActionItem, type ActionItemsReport, type CallSpeaker } from "../../shared/ipc";
import { formatClock, groupTurns, speakerLabel, type Turn } from "../../shared/transcript";
import type { HaikuClient } from "../calendar/BedrockHaiku";
import type { ActionItemStore, StoredActionItems } from "./ActionItemStore";
import type { RecordingStore } from "./RecordingStore";

/** The soonest Haiku looks at a call again; the Recordings tab asks more often than that. */
export const MIN_CHECK_GAP_MS = 60_000;

/** The most action items kept for one call. */
export const MAX_ITEMS = 10;

/** The most transcript sent in one look (~25k tokens); a longer call sends its latest part. */
export const MAX_TRANSCRIPT_CHARS = 100_000;

/** The longest item kept, in characters; anything longer is cut. */
const MAX_ITEM_CHARS = 200;

/** The tool Haiku answers through, so its reply is a list rather than prose. */
const ANSWER_TOOL = "record_action_items";

/** What Haiku should look for. */
const SYSTEM_PROMPT = [
  "You read the transcript of a call that is still going and list its potential action items: concrete " +
    "things someone said they would do, agreed to do, or was asked to do (send something, follow up, fix, " +
    "decide, book). Not topics that were only discussed, and not things already done during the call.",
  'In the transcript, "You" is the user\'s own microphone and "Them" is everyone else (speech recognition ' +
    "can't tell the other people apart, and may mishear words).",
  'Write each item as a short instruction that starts with who will do it when that\'s clear, e.g. "You: send ' +
    'Dana the sandbox keys" or "Them: check the invoice total". Use names when the call says them.',
  "Keep the wording of items found earlier unless the call changed them; drop any the call has since " +
    `cancelled or finished. Give each item the number of the turn where it was said. At most ${MAX_ITEMS} items; ` +
    "an empty list is fine.",
].join("\n");

/** What finding action items needs, injected for tests. */
export interface ActionItemDeps {
  recordings: Pick<RecordingStore, "getRecording" | "listLines">;
  store: Pick<ActionItemStore, "getItems" | "saveItems">;
  /** Haiku on Bedrock. */
  haiku: Pick<HaikuClient, "invoke">;
  /** A call's speakers, so the transcript names who said what. */
  speakers(recordingId: number): CallSpeaker[];
  now(): number;
}

/**
 * Finds a call's potential action items with Haiku while you watch it on the Recordings tab. The tab asks
 * every few seconds; Haiku is only called when the call has new words and a minute has passed since the last
 * look, and only one look per call runs at a time. Results are saved, so the call keeps them afterwards.
 */
export class ActionItemFinder {
  private readonly running = new Map<number, Promise<ActionItemsReport>>();
  private readonly problems = new Map<number, string>();
  /** When each call was last sent to Haiku, failed tries included, so a failure isn't retried every poll. */
  private readonly lastTry = new Map<number, number>();

  /** @param deps The stores, Haiku and the clock. */
  constructor(private readonly deps: ActionItemDeps) {}

  /**
   * Brings a call's action items up to date if it's time to, and returns them.
   * @param recordingId The call.
   * @returns Its items, newest first, and why the last look failed if it did.
   */
  refresh(recordingId: number): Promise<ActionItemsReport> {
    const running = this.running.get(recordingId);
    if (running) {
      return running;
    }
    const look = this.look(recordingId).finally(() => this.running.delete(recordingId));
    this.running.set(recordingId, look);
    return look;
  }

  /**
   * Sends the call to Haiku when it has new words and the last look was over a minute ago. Once the call
   * has ended there's no wait, so its last words get looked at before the live card goes; a call that ended
   * longer ago than CALL_FINISHING_MS is never sent at all.
   * @param recordingId The call.
   * @returns Its items.
   */
  private async look(recordingId: number): Promise<ActionItemsReport> {
    const recording = this.deps.recordings.getRecording(recordingId);
    if (!recording) {
      throw new Error("That call isn't recorded.");
    }
    const saved = this.deps.store.getItems(recordingId);
    const lines = this.deps.recordings.listLines(recordingId);
    const heardUntil = Math.max(0, ...lines.map((line) => line.end));
    const now = this.deps.now();
    if (recording.end !== null && now - recording.end > CALL_FINISHING_MS) {
      return this.report(recordingId, saved);
    }
    const lastTry = this.lastTry.get(recordingId) ?? saved?.checkedAt ?? 0;
    const tooSoon = recording.end === null && now - lastTry < MIN_CHECK_GAP_MS;
    const nothingNew =
      lines.length === 0 || (saved !== null && heardUntil <= saved.coveredUntil && lines.length <= saved.coveredLines);
    if (nothingNew || tooSoon) {
      return this.report(recordingId, saved);
    }
    this.lastTry.set(recordingId, now);
    try {
      const speakers = this.deps.speakers(recordingId);
      const turns = latestTurns(groupTurns(lines, speakers), MAX_TRANSCRIPT_CHARS);
      // Items said before the part that was sent can't be re-found, so they're kept as they were, and not
      // shown to Haiku, which would otherwise restate them inside the part it read.
      const cutOff = turns[0]?.start ?? 0;
      const earlier = (saved?.items ?? []).filter((item) => item.saidAt >= cutOff);
      const kept = (saved?.items ?? []).filter((item) => item.saidAt < cutOff);
      const found = readItems(await this.deps.haiku.invoke(buildRequest(turns, earlier, speakers)), turns);
      const items = [...found, ...kept.filter((item) => !found.some((match) => match.text === item.text))].slice(0, MAX_ITEMS);
      const next: StoredActionItems = { recordingId, items, coveredUntil: heardUntil, coveredLines: lines.length, checkedAt: now };
      this.deps.store.saveItems(next);
      this.problems.delete(recordingId);
      return this.report(recordingId, next);
    } catch (error) {
      this.problems.set(recordingId, error instanceof Error ? error.message : String(error));
      return this.report(recordingId, saved);
    }
  }

  /**
   * Puts a call's items and its last problem together for the tab.
   * @param recordingId The call.
   * @param saved Its saved items, if any.
   * @returns The report.
   */
  private report(recordingId: number, saved: StoredActionItems | null): ActionItemsReport {
    return { items: saved?.items ?? [], checkedAt: saved?.checkedAt ?? null, problem: this.problems.get(recordingId) ?? null };
  }
}

/**
 * Keeps the latest turns that fit, so a long call sends its most recent part. A newest turn too long by
 * itself (a webinar: one side talking for hours) is kept with only its end.
 * @param turns The call's turns, oldest first.
 * @param limit The most characters.
 * @returns The turns kept, oldest first; empty only when there are none.
 */
export function latestTurns(turns: Turn[], limit: number): Turn[] {
  let total = 0;
  let first = turns.length;
  while (first > 0 && total + turns[first - 1].text.length <= limit) {
    first--;
    total += turns[first].text.length;
  }
  const last = turns.at(-1);
  if (first === turns.length && last) {
    return [{ ...last, text: last.text.slice(-limit) }];
  }
  return turns.slice(first);
}

/**
 * Builds the request: the numbered turns, the items found earlier, and a tool to answer through.
 * @param turns The turns to read, oldest first.
 * @param earlier The items found last time.
 * @param speakers The call's speakers, to name who said each turn.
 * @returns The Messages API body.
 */
export function buildRequest(turns: Turn[], earlier: ActionItem[], speakers: readonly CallSpeaker[] = []): object {
  const transcript = turns
    .map((turn, index) => `[${index}] ${formatClock(turn.start)} ${speakerLabel(turn, speakers)}: ${turn.text}`)
    .join("\n");
  const found =
    earlier.length === 0
      ? "None yet."
      : earlier.map((item) => `- ${item.text} (said at ${formatClock(item.saidAt)})`).join("\n");
  return {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 1_000,
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: ANSWER_TOOL,
        description: "Records the call's potential action items.",
        input_schema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  turn: { type: "integer", description: "The number of the turn where it was said." },
                  text: { type: "string", description: "The action item, starting with who will do it." },
                },
                required: ["turn", "text"],
              },
            },
          },
          required: ["items"],
        },
      },
    ],
    tool_choice: { type: "tool", name: ANSWER_TOOL },
    messages: [
      {
        role: "user",
        content: `<transcript>\n${transcript}\n</transcript>\n\nAction items found earlier:\n${found}`,
      },
    ],
  };
}

/**
 * Reads Haiku's items, trusting nothing: an item needs real text and a turn that exists.
 * @param reply Haiku's reply.
 * @param turns The turns it was sent, to turn each turn number into a time.
 * @returns The items, newest first, at most MAX_ITEMS.
 */
export function readItems(reply: unknown, turns: Turn[]): ActionItem[] {
  const content = (reply as { content?: { type?: unknown; name?: unknown; input?: unknown }[] } | null)?.content;
  const call = Array.isArray(content) ? content.find((block) => block.type === "tool_use" && block.name === ANSWER_TOOL) : undefined;
  const list = (call?.input as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(list)) {
    throw new Error("Haiku didn't send back a list of action items.");
  }
  const items: ActionItem[] = [];
  for (const entry of list as { turn?: unknown; text?: unknown }[]) {
    const turn = typeof entry?.turn === "number" && Number.isInteger(entry.turn) ? turns[entry.turn] : undefined;
    const text = typeof entry?.text === "string" ? entry.text.replace(/\s+/g, " ").trim().slice(0, MAX_ITEM_CHARS) : "";
    if (turn && text !== "" && !items.some((item) => item.text === text)) {
      items.push({ text, saidAt: turn.start });
    }
  }
  return items.sort((a, b) => b.saidAt - a.saidAt).slice(0, MAX_ITEMS);
}
