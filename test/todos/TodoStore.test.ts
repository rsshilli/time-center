import { RecordingStore } from "../../src/main/recording/RecordingStore";
import { Store } from "../../src/main/store/Store";
import { TodoStore } from "../../src/main/todos/TodoStore";

const NOW = new Date(2026, 10, 10, 9).getTime();
const MIN = 60_000;

describe("TodoStore", () => {
  let store: Store;
  let todos: TodoStore;

  beforeEach(() => {
    store = new Store(":memory:");
    todos = new TodoStore(store.db);
  });

  afterEach(() => {
    store.close();
  });

  /** The list's text, in order. */
  const texts = () => todos.listTodos().map((todo) => todo.markdown);

  it("should add each new item at the top and keep its text and time", () => {
    todos.addTodo({ markdown: "First", source: null }, NOW);
    const id = todos.addTodo({ markdown: "**Second**", source: null }, NOW + MIN);

    expect(texts()).toEqual(["**Second**", "First"]);
    expect(todos.getTodo(id)).toEqual({ id, markdown: "**Second**", createdAt: NOW + MIN, doneAt: null, source: null, sent: [] });
  });

  it("should keep the call an item came from, and the title and time once the call is deleted", () => {
    const recordings = new RecordingStore(store.db);
    const recordingId = recordings.insertRecording(NOW, "/tmp/none");
    const id = todos.addTodo({ markdown: "Send the keys", source: { recordingId, title: "Weekly sync", saidAt: NOW + MIN } }, NOW);
    expect(todos.getTodo(id)?.source).toEqual({ recordingId, title: "Weekly sync", saidAt: NOW + MIN });

    store.db.prepare("DELETE FROM recordings WHERE id = ?").run(recordingId);

    expect(todos.getTodo(id)?.source).toEqual({ recordingId: null, title: "Weekly sync", saidAt: NOW + MIN });
  });

  it("should put done items after the rest, most recently done first, and send an unticked item back to the top", () => {
    const a = todos.addTodo({ markdown: "a", source: null }, NOW);
    const b = todos.addTodo({ markdown: "b", source: null }, NOW);
    todos.addTodo({ markdown: "c", source: null }, NOW);
    todos.setDone(a, true, NOW + MIN);
    todos.setDone(b, true, NOW + 2 * MIN);
    expect(texts()).toEqual(["c", "b", "a"]);
    expect(todos.getTodo(b)?.doneAt).toBe(NOW + 2 * MIN);

    todos.setDone(a, false, NOW + 3 * MIN);

    expect(texts()).toEqual(["a", "c", "b"]);
    expect(todos.getTodo(a)?.doneAt).toBeNull();
  });

  it("should reorder the items still to do, and refuse an order that leaves one out or names a done one", () => {
    const a = todos.addTodo({ markdown: "a", source: null }, NOW);
    const b = todos.addTodo({ markdown: "b", source: null }, NOW);
    const c = todos.addTodo({ markdown: "c", source: null }, NOW);
    const done = todos.addTodo({ markdown: "done", source: null }, NOW);
    todos.setDone(done, true, NOW);

    todos.reorder([a, c, b]);
    expect(texts()).toEqual(["a", "c", "b", "done"]);

    expect(() => todos.reorder([a, b])).toThrow(/list changed/);
    expect(() => todos.reorder([a, b, c, done])).toThrow(/list changed/);
    expect(() => todos.reorder([a, a, b])).toThrow(/list changed/);
    expect(texts()).toEqual(["a", "c", "b", "done"]);
  });

  it("should edit, delete and clear done items, and say when an item is gone", () => {
    const a = todos.addTodo({ markdown: "a", source: null }, NOW);
    const b = todos.addTodo({ markdown: "b", source: null }, NOW);
    todos.updateTodo(a, "a, edited");
    todos.setDone(b, true, NOW);
    todos.clearDone();
    expect(texts()).toEqual(["a, edited"]);

    todos.deleteTodo(a);

    expect(texts()).toEqual([]);
    expect(() => todos.updateTodo(a, "x")).toThrow(/no longer on your list/);
    expect(() => todos.setDone(a, true, NOW)).toThrow(/no longer on your list/);
    expect(() => todos.deleteTodo(a)).toThrow(/no longer on your list/);
  });

  it("should record each place an item was sent", () => {
    const id = todos.addTodo({ markdown: "a", source: null }, NOW);
    todos.addSent(id, { action: "jira", label: "QI-1", url: "https://x/browse/QI-1", at: NOW });
    todos.addSent(id, { action: "jira", label: "QI-2", url: null, at: NOW + MIN });

    expect(todos.getTodo(id)?.sent.map((sent) => sent.label)).toEqual(["QI-1", "QI-2"]);
    expect(() => todos.addSent(999, { action: "jira", label: "QI-3", url: null, at: NOW })).toThrow(/no longer/);
  });
});
