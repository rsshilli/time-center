import { RecordingStore } from "../../src/main/recording/RecordingStore";
import { Store } from "../../src/main/store/Store";
import { TodoStore } from "../../src/main/todos/TodoStore";
import type { TodoSection } from "../../src/shared/ipc";

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

  /** Adds an item with no call behind it. */
  const add = (markdown: string, section: TodoSection = "work", at = NOW) => todos.addTodo({ markdown, section, source: null }, at);

  /** The items still to do in one section, in order. */
  const inSection = (section: TodoSection) =>
    todos
      .listTodos()
      .filter((todo) => todo.doneAt === null && todo.section === section)
      .map((todo) => todo.markdown);

  it("should add each new item at the top and keep its text, section and time", () => {
    add("First");
    const id = add("**Second**", "personal", NOW + MIN);

    expect(texts()).toEqual(["**Second**", "First"]);
    expect(todos.getTodo(id)).toEqual({ id, markdown: "**Second**", section: "personal", createdAt: NOW + MIN, doneAt: null, source: null, sent: [] });
  });

  it("should keep the call an item came from, and the title and time once the call is deleted", () => {
    const recordings = new RecordingStore(store.db);
    const recordingId = recordings.insertRecording(NOW, "/tmp/none");
    const id = todos.addTodo({ markdown: "Send the keys", section: "work", source: { recordingId, title: "Weekly sync", saidAt: NOW + MIN } }, NOW);
    expect(todos.getTodo(id)?.source).toEqual({ recordingId, title: "Weekly sync", saidAt: NOW + MIN });

    store.db.prepare("DELETE FROM recordings WHERE id = ?").run(recordingId);

    expect(todos.getTodo(id)?.source).toEqual({ recordingId: null, title: "Weekly sync", saidAt: NOW + MIN });
  });

  it("should put done items after the rest, most recently done first, and send an unticked item back to the top of its section", () => {
    const a = add("a", "personal");
    const b = add("b");
    add("c");
    todos.setDone(a, true, NOW + MIN);
    todos.setDone(b, true, NOW + 2 * MIN);
    expect(texts()).toEqual(["c", "b", "a"]);
    expect(todos.getTodo(b)?.doneAt).toBe(NOW + 2 * MIN);

    todos.setDone(a, false, NOW + 3 * MIN);

    expect(texts()).toEqual(["a", "c", "b"]);
    expect(todos.getTodo(a)).toEqual(expect.objectContaining({ doneAt: null, section: "personal" }));
  });

  it("should reorder the items still to do, and refuse an order that leaves one out or names a done one", () => {
    const a = add("a");
    const b = add("b");
    const c = add("c");
    const done = add("done");
    todos.setDone(done, true, NOW);

    todos.arrange({ work: [a, c, b], personal: [] });
    expect(texts()).toEqual(["a", "c", "b", "done"]);

    expect(() => todos.arrange({ work: [a, b], personal: [] })).toThrow(/list changed/);
    expect(() => todos.arrange({ work: [a, b, c, done], personal: [] })).toThrow(/list changed/);
    expect(() => todos.arrange({ work: [a, a, b], personal: [] })).toThrow(/list changed/);
    expect(() => todos.arrange({ work: [a, b, c], personal: [c] })).toThrow(/list changed/);
    expect(texts()).toEqual(["a", "c", "b", "done"]);
  });

  it("should move an item into the other section at the place it was dropped", () => {
    const a = add("a");
    const b = add("b");
    const home = add("home", "personal");

    todos.arrange({ work: [a], personal: [home, b] });

    expect(inSection("work")).toEqual(["a"]);
    expect(inSection("personal")).toEqual(["home", "b"]);
    expect(todos.getTodo(b)?.section).toBe("personal");
  });

  it("should put items made before sections existed in Work", () => {
    store.db.prepare("INSERT INTO todos (markdown, position, created_at) VALUES ('old', 0, ?)").run(new Date(NOW).toISOString());

    expect(todos.listTodos()[0].section).toBe("work");
  });

  it("should edit, delete and clear done items, and say when an item is gone", () => {
    const a = add("a");
    const b = add("b");
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
    const id = add("a");
    todos.addSent(id, { action: "jira", label: "QI-1", url: "https://x/browse/QI-1", at: NOW });
    todos.addSent(id, { action: "jira", label: "QI-2", url: null, at: NOW + MIN });

    expect(todos.getTodo(id)?.sent.map((sent) => sent.label)).toEqual(["QI-1", "QI-2"]);
    expect(() => todos.addSent(999, { action: "jira", label: "QI-3", url: null, at: NOW })).toThrow(/no longer/);
  });
});
