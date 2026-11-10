import type { DatabaseSync } from "node:sqlite";
import type { NewTodo, Todo, TodoSent } from "../../shared/ipc";

/**
 * The todos table (migration 13): your TODO list. Items still to do are kept in your order (position);
 * done items sort after them, most recently done first.
 */
export class TodoStore {
  /** @param db The open database. */
  constructor(private readonly db: DatabaseSync) {}

  /**
   * The whole list.
   * @returns Items to do in your order, then done items, most recently done first.
   */
  listTodos(): Todo[] {
    const rows = this.db
      .prepare("SELECT * FROM todos ORDER BY done_at IS NOT NULL, done_at DESC, position, id")
      .all() as Record<string, unknown>[];
    return rows.map(toTodo);
  }

  /**
   * One item.
   * @param id The item.
   * @returns It, or null when there's no such item.
   */
  getTodo(id: number): Todo | null {
    const row = this.db.prepare("SELECT * FROM todos WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toTodo(row) : null;
  }

  /**
   * Adds an item at the top of the list.
   * @param todo Its text and the call it came from.
   * @param now When it was added.
   * @returns Its id.
   */
  addTodo(todo: NewTodo, now: number): number {
    const result = this.db
      .prepare(
        `INSERT INTO todos (markdown, position, created_at, source_recording_id, source_title, source_said_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        todo.markdown,
        this.topPosition() - 1,
        new Date(now).toISOString(),
        todo.source?.recordingId ?? null,
        todo.source?.title ?? null,
        todo.source ? new Date(todo.source.saidAt).toISOString() : null,
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * Replaces an item's text.
   * @param id The item.
   * @param markdown The new text.
   */
  updateTodo(id: number, markdown: string): void {
    this.assertChanged(this.db.prepare("UPDATE todos SET markdown = ? WHERE id = ?").run(markdown, id).changes);
  }

  /**
   * Ticks or unticks an item. An unticked item goes back to the top of the list.
   * @param id The item.
   * @param done Whether it's done.
   * @param now When.
   */
  setDone(id: number, done: boolean, now: number): void {
    const changes = done
      ? this.db.prepare("UPDATE todos SET done_at = ? WHERE id = ?").run(new Date(now).toISOString(), id).changes
      : this.db.prepare("UPDATE todos SET done_at = NULL, position = ? WHERE id = ?").run(this.topPosition() - 1, id).changes;
    this.assertChanged(changes);
  }

  /**
   * Puts the items still to do in this order.
   * @param ids Every item still to do, in the new order.
   */
  reorder(ids: number[]): void {
    const open = (this.db.prepare("SELECT id FROM todos WHERE done_at IS NULL").all() as { id: number }[]).map((row) => Number(row.id));
    const same = ids.length === open.length && new Set(ids).size === ids.length && ids.every((id) => open.includes(id));
    if (!same) {
      throw new Error("The list changed while you were dragging; try again.");
    }
    const update = this.db.prepare("UPDATE todos SET position = ? WHERE id = ?");
    this.db.exec("BEGIN");
    try {
      ids.forEach((id, index) => update.run(index, id));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Deletes an item.
   * @param id The item.
   */
  deleteTodo(id: number): void {
    this.assertChanged(this.db.prepare("DELETE FROM todos WHERE id = ?").run(id).changes);
  }

  /** Deletes every done item. */
  clearDone(): void {
    this.db.prepare("DELETE FROM todos WHERE done_at IS NOT NULL").run();
  }

  /**
   * Records where an item was sent, such as the Jira ticket made from it.
   * @param id The item.
   * @param sent Where it went.
   */
  addSent(id: number, sent: TodoSent): void {
    const todo = this.getTodo(id);
    if (!todo) {
      throw new Error("That item is no longer on your list.");
    }
    this.db.prepare("UPDATE todos SET sent = ? WHERE id = ?").run(JSON.stringify([...todo.sent, sent]), id);
  }

  /**
   * The smallest position in use, so a new item can go above it.
   * @returns It, or 0 when the list is empty.
   */
  private topPosition(): number {
    const row = this.db.prepare("SELECT MIN(position) AS top FROM todos").get() as { top: number | null };
    return row.top === null ? 0 : Number(row.top);
  }

  /**
   * Fails when a change touched no item, so a stale window hears the item is gone.
   * @param changes Rows changed.
   */
  private assertChanged(changes: number | bigint): void {
    if (Number(changes) === 0) {
      throw new Error("That item is no longer on your list.");
    }
  }
}

/**
 * Turns a row into an item.
 * @param row The row.
 * @returns The item.
 */
function toTodo(row: Record<string, unknown>): Todo {
  return {
    id: Number(row.id),
    markdown: String(row.markdown),
    createdAt: Date.parse(String(row.created_at)),
    doneAt: row.done_at === null ? null : Date.parse(String(row.done_at)),
    source:
      row.source_title === null
        ? null
        : {
            recordingId: row.source_recording_id === null ? null : Number(row.source_recording_id),
            title: String(row.source_title),
            saidAt: Date.parse(String(row.source_said_at)),
          },
    sent: parseSent(String(row.sent)),
  };
}

/**
 * Reads the saved list of places an item was sent, treating a damaged one as empty.
 * @param json The column's text.
 * @returns The list.
 */
function parseSent(json: string): TodoSent[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? (value as TodoSent[]) : [];
  } catch {
    return [];
  }
}
