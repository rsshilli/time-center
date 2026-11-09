import type { DatabaseSync } from "node:sqlite";
import type { ActionItem } from "../../shared/ipc";

/** A call's saved action items. */
export interface StoredActionItems {
  recordingId: number;
  /** Newest first. */
  items: ActionItem[];
  /** The end of the last transcript line Haiku had read. */
  coveredUntil: number;
  /** How many transcript lines Haiku had read. */
  coveredLines: number;
  checkedAt: number;
}

/** The recording_action_items table (migration 11): one row per call, replaced each time Haiku looks. */
export class ActionItemStore {
  /** @param db The open database. */
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Saves a call's action items, replacing what was there.
   * @param saved The items and how far through the call they go.
   */
  saveItems(saved: StoredActionItems): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO recording_action_items (recording_id, items, covered_until, covered_lines, checked_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        saved.recordingId,
        JSON.stringify(saved.items),
        new Date(saved.coveredUntil).toISOString(),
        saved.coveredLines,
        new Date(saved.checkedAt).toISOString(),
      );
  }

  /**
   * A call's action items.
   * @param recordingId The call.
   * @returns Them, or null if Haiku never looked at it.
   */
  getItems(recordingId: number): StoredActionItems | null {
    const row = this.db.prepare("SELECT * FROM recording_action_items WHERE recording_id = ?").get(recordingId) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      return null;
    }
    return {
      recordingId,
      items: parseItems(String(row.items)),
      coveredUntil: Date.parse(String(row.covered_until)),
      coveredLines: Number(row.covered_lines),
      checkedAt: Date.parse(String(row.checked_at)),
    };
  }
}

/**
 * Reads a saved items list, treating a damaged one as empty rather than failing the whole Recordings tab.
 * @param json The column's text.
 * @returns The items.
 */
function parseItems(json: string): ActionItem[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? (value as ActionItem[]) : [];
  } catch {
    return [];
  }
}
