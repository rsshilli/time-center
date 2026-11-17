import type { DatabaseSync } from "node:sqlite";
import type { SuggestionRef } from "../../shared/ipc";

/** The longest suggestion text accepted from the renderer; a suggestion is never near this long. */
export const MAX_SUGGESTION_CHARS = 1_000;

/**
 * The recording_dismissed_suggestions table (migration 20): the suggested TODOs you dismissed on the Recordings
 * tab, a call's "Possible TODOs" and the TODOs found while answering a question alike. A suggestion is known by
 * its call, the moment it was said and its words, which is all both kinds have in common.
 */
export class DismissedSuggestions {
  /** @param db The open database. */
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Dismisses a suggestion, so it's no longer shown. Dismissing it twice is the same as once.
   * @param ref The suggestion.
   * @param at When.
   */
  dismiss(ref: SuggestionRef, at: number): void {
    this.db
      .prepare("INSERT OR IGNORE INTO recording_dismissed_suggestions (recording_id, said_at, text, dismissed_at) VALUES (?, ?, ?, ?)")
      .run(ref.recordingId, ref.saidAt, ref.text, new Date(at).toISOString());
  }

  /**
   * Brings a dismissed suggestion back (Undo).
   * @param ref The suggestion.
   */
  restore(ref: SuggestionRef): void {
    this.db
      .prepare("DELETE FROM recording_dismissed_suggestions WHERE recording_id = ? AND said_at = ? AND text = ?")
      .run(ref.recordingId, ref.saidAt, ref.text);
  }

  /**
   * A call's dismissed suggestions.
   * @param recordingId The call.
   * @returns Them, oldest said first.
   */
  list(recordingId: number): SuggestionRef[] {
    const rows = this.db
      .prepare("SELECT said_at, text FROM recording_dismissed_suggestions WHERE recording_id = ? ORDER BY said_at")
      .all(recordingId) as { said_at: number; text: string }[];
    return rows.map((row) => ({ recordingId, saidAt: Number(row.said_at), text: String(row.text) }));
  }

  /**
   * Leaves out the suggestions you dismissed.
   * @param suggestions Suggestions, from any calls.
   * @returns The ones not dismissed, in the same order.
   */
  without<T extends SuggestionRef>(suggestions: T[]): T[] {
    if (suggestions.length === 0) {
      return suggestions;
    }
    const check = this.db.prepare("SELECT 1 FROM recording_dismissed_suggestions WHERE recording_id = ? AND said_at = ? AND text = ?");
    return suggestions.filter((suggestion) => check.get(suggestion.recordingId, suggestion.saidAt, suggestion.text) === undefined);
  }
}

/**
 * Checks a suggestion sent by the renderer.
 * @param value What it sent.
 * @returns The suggestion, typed.
 */
export function assertSuggestionRef(value: unknown): SuggestionRef {
  const ref = value as Partial<SuggestionRef> | null;
  if (typeof ref !== "object" || ref === null) {
    throw new Error("Not a suggested TODO.");
  }
  if (!Number.isSafeInteger(ref.recordingId) || (ref.recordingId as number) <= 0) {
    throw new Error("Not a recorded call.");
  }
  if (typeof ref.saidAt !== "number" || !Number.isFinite(ref.saidAt)) {
    throw new Error("Not a moment in the call.");
  }
  if (typeof ref.text !== "string" || ref.text.trim() === "" || ref.text.length > MAX_SUGGESTION_CHARS) {
    throw new Error("Not a suggested TODO.");
  }
  return { recordingId: ref.recordingId as number, saidAt: ref.saidAt, text: ref.text };
}
