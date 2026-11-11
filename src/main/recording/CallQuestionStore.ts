import type { DatabaseSync } from "node:sqlite";
import type { CallQuestion, CallQuestionScope, CallQuestionSource, CallQuestionTodo } from "../../shared/ipc";

/** A question to save: everything but its id. */
export type NewCallQuestion = Omit<CallQuestion, "id">;

/** The recording_questions table (migration 10): the questions you asked about your calls, and the answers. */
export class CallQuestionStore {
  /** @param db The open database. */
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Saves a question with its answer or error.
   * @param question The question.
   * @returns It, with its new id.
   */
  insertQuestion(question: NewCallQuestion): CallQuestion {
    const result = this.db
      .prepare(
        "INSERT INTO recording_questions (asked_at, question, scope, sources, note, answer, error, todos) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        new Date(question.askedAt).toISOString(),
        question.question,
        question.scope,
        JSON.stringify(question.sources),
        question.note,
        question.answer,
        question.error,
        JSON.stringify(question.todos),
      );
    return { id: Number(result.lastInsertRowid), ...question };
  }

  /**
   * The questions asked most recently.
   * @param limit How many.
   * @returns Them, newest first.
   */
  listQuestions(limit: number): CallQuestion[] {
    const rows = this.db
      .prepare("SELECT * FROM recording_questions ORDER BY asked_at DESC, id DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id),
      askedAt: Date.parse(String(row.asked_at)),
      question: String(row.question),
      scope: String(row.scope) as CallQuestionScope,
      sources: parseList<CallQuestionSource>(String(row.sources)),
      note: row.note === null ? null : String(row.note),
      answer: row.answer === null ? null : String(row.answer),
      error: row.error === null ? null : String(row.error),
      todos: parseList<CallQuestionTodo>(String(row.todos)),
    }));
  }
}

/**
 * Reads a saved JSON list, treating a damaged one as empty rather than hiding the whole history.
 * @param json The column's text.
 * @returns The list.
 */
function parseList<T>(json: string): T[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}
