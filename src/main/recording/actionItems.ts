import type { ActionItem, ActionItemsReport, CallSpeaker } from "../../shared/ipc";
import { formatClock, groupTurns, speakerLabel, type Turn } from "../../shared/transcript";
import type { HaikuClient } from "../calendar/BedrockHaiku";
import type { ActionItemStore, StoredActionItems } from "./ActionItemStore";
import type { RecordingStore } from "./RecordingStore";

/** The most action items one scan answers with. */
export const MAX_ITEMS = 10;

/** The most transcript sent in one look (~25k tokens); a longer call sends its latest part. */
export const MAX_TRANSCRIPT_CHARS = 100_000;

/** The most items saved for one call: the latest scan's answer plus the earlier ones it left out. */
export const MAX_KEPT = 30;

/** The longest item kept, in characters; anything longer is cut. */
const MAX_ITEM_CHARS = 200;

/** The tool the model answers through, so its reply is a list rather than prose. */
const ANSWER_TOOL = "record_action_items";

/** What the model should look for. */
const SYSTEM_PROMPT = [
  "You read the transcript of a call (it may still be going) and list its potential action items: concrete " +
    "things someone said they would do, agreed to do, or was asked to do (send something, follow up, fix, " +
    "decide, book). Not topics that were only discussed, and not things already done during the call.",
  'In the transcript, "You" is the user\'s own microphone and "Them" is everyone else (speech recognition ' +
    "can't tell the other people apart, and may mishear words).",
  'Write each item as a short instruction that starts with who will do it when that\'s clear, e.g. "You: send ' +
    'Dana the sandbox keys" or "Them: check the invoice total". Use names when the call says them.',
  "List the items found earlier again, keeping their wording unless the call changed them, plus any new ones. " +
    `Give each item the number of the turn where it was said. At most ${MAX_ITEMS} items; an empty list is fine.`,
  `Answer only by calling the ${ANSWER_TOOL} tool, once, with no other text.`,
].join("\n");

/** What finding action items needs, injected for tests. */
export interface ActionItemDeps {
  recordings: Pick<RecordingStore, "getRecording" | "listLines">;
  store: Pick<ActionItemStore, "getItems" | "saveItems" | "listDismissed">;
  /** Sonnet on Bedrock. */
  model: Pick<HaikuClient, "invoke">;
  /** A call's speakers, so the transcript names who said what. */
  speakers(recordingId: number): CallSpeaker[];
  now(): number;
}

/**
 * Scans a call for potential action items with Sonnet when you press Scan for TODOs — on the live call or
 * any past one. Nothing runs in the background. One scan per call runs at a time; a second press shares it.
 * Results are saved, so the call keeps them afterwards.
 */
export class ActionItemFinder {
  private readonly running = new Map<number, Promise<ActionItemsReport>>();

  /** @param deps The stores, the model and the clock. */
  constructor(private readonly deps: ActionItemDeps) {}

  /**
   * Scans a call now, or joins the scan of it already running.
   * @param recordingId The call.
   * @returns Its items, newest first. Throws when the model can't be reached; the saved items stay.
   */
  scan(recordingId: number): Promise<ActionItemsReport> {
    const running = this.running.get(recordingId);
    if (running) {
      return running;
    }
    const look = this.look(recordingId).finally(() => this.running.delete(recordingId));
    this.running.set(recordingId, look);
    return look;
  }

  /**
   * Sends the call's latest part to the model with the items found so far, and saves what it finds on top.
   * @param recordingId The call.
   * @returns Its items.
   */
  private async look(recordingId: number): Promise<ActionItemsReport> {
    if (!this.deps.recordings.getRecording(recordingId)) {
      throw new Error("That call isn't recorded.");
    }
    // Dismissed items included: they stay saved, hidden, so Undo can bring them back after another scan.
    const saved = this.deps.store.getItems(recordingId, true);
    const lines = this.deps.recordings.listLines(recordingId);
    if (lines.length === 0) {
      throw new Error("Nothing has been said in this call yet.");
    }
    const now = this.deps.now();
    const speakers = this.deps.speakers(recordingId);
    const turns = latestTurns(groupTurns(lines, speakers), MAX_TRANSCRIPT_CHARS);
    const dismissed = this.deps.store.listDismissed(recordingId);
    const shown = (saved?.items ?? []).filter((item) => !isDismissed(item, dismissed));
    const parked = (saved?.items ?? []).filter((item) => isDismissed(item, dismissed));
    // Items said before the part that was sent can't be re-found, so they're kept as they were, and not
    // shown to the model, which would otherwise restate them inside the part it read.
    const cutOff = turns[0]?.start ?? 0;
    const earlier = shown.filter((item) => item.saidAt >= cutOff);
    const kept = shown.filter((item) => item.saidAt < cutOff);
    // Ones you dismissed are shown to the model so it doesn't suggest them again, and left out if it does anyway.
    // Matched on words alone here: the same words in the same call are the same suggestion, even when the model
    // places it on a neighbouring turn this time.
    const found = readItems(await this.deps.model.invoke(buildRequest(turns, earlier, speakers, dismissed)), turns).filter(
      (item) => !dismissed.some((gone) => gone.text === item.text),
    );
    // A scan can add and reword, never take away: one empty or short answer used to wipe the whole list in the
    // middle of a call. Only Dismiss removes a suggestion.
    const items = keepEarlier(found, [...earlier, ...kept]).slice(0, MAX_KEPT);
    const next: StoredActionItems = {
      recordingId,
      items: [...items, ...parked],
      coveredUntil: Math.max(0, ...lines.map((line) => line.end)),
      coveredLines: lines.length,
      checkedAt: now,
    };
    this.deps.store.saveItems(next);
    return { items, checkedAt: now };
  }
}

/**
 * Puts Haiku's new answer together with the items it had before, so nothing it leaves out goes missing. An
 * earlier item stays unless the answer has the same words, or rewords it: the answer has at least as many items
 * said at that moment as there were before.
 * @param found Haiku's items, newest first.
 * @param before The call's items before this look.
 * @returns Them all, newest first.
 */
export function keepEarlier(found: readonly ActionItem[], before: readonly ActionItem[]): ActionItem[] {
  const count = (list: readonly ActionItem[], saidAt: number) => list.filter((item) => item.saidAt === saidAt).length;
  const missing = before.filter(
    (item) => !found.some((match) => match.text === item.text) && count(found, item.saidAt) < count(before, item.saidAt),
  );
  return [...found, ...missing].sort((a, b) => b.saidAt - a.saidAt);
}

/**
 * Whether an action item is one you dismissed: the same words said at the same moment.
 * @param item The item.
 * @param dismissed The call's dismissed items.
 * @returns True when dismissed.
 */
function isDismissed(item: ActionItem, dismissed: readonly ActionItem[]): boolean {
  return dismissed.some((gone) => gone.saidAt === item.saidAt && gone.text === item.text);
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
 * @param dismissed Items you dismissed from this call, which Haiku shouldn't suggest again.
 * @returns The Messages API body.
 */
export function buildRequest(
  turns: Turn[],
  earlier: ActionItem[],
  speakers: readonly CallSpeaker[] = [],
  dismissed: readonly ActionItem[] = [],
): object {
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
    // Sonnet 5.5 on Bedrock refuses a forced tool ("type tool and any are not supported for this model", probe
    // 2026-11-20), so it's left to choose, and told to answer only through the tool.
    tool_choice: { type: "auto" },
    messages: [
      {
        role: "user",
        content:
          `<transcript>\n${transcript}\n</transcript>\n\nAction items found earlier:\n${found}` +
          (dismissed.length === 0
            ? ""
            : "\n\nThe user dismissed these as not action items. Don't list them again, reworded or not:\n" +
              dismissed.map((item) => `- ${item.text} (said at ${formatClock(item.saidAt)})`).join("\n")),
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
