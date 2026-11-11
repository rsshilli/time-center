import { MAX_TODO_CHARS } from "../../src/shared/ipc";
import { Store } from "../../src/main/store/Store";
import { TodoStore } from "../../src/main/todos/TodoStore";
import { type TodoAction, assertLayout, assertNewTodo, describeActions, recordSent, runTodoAction } from "../../src/main/todos/todoIpc";

const NOW = new Date(2026, 10, 10, 9).getTime();

describe("todoIpc", () => {
  let store: Store;
  let todos: TodoStore;

  beforeEach(() => {
    store = new Store(":memory:");
    todos = new TodoStore(store.db);
  });

  afterEach(() => {
    store.close();
  });

  /** An action that sends every item to "X-1". */
  const action = (unavailable: string | null): TodoAction => ({
    id: "jira",
    label: "Make a Jira ticket",
    unavailable: () => unavailable,
    run: vi.fn(async () => ({ action: "ignored", label: "X-1", url: "https://x/X-1" })),
  });

  it("should run an action on an item and record where it went, under the action's own id", async () => {
    const id = todos.addTodo({ markdown: "a", section: "work", source: null }, NOW);
    const jira = action(null);

    await runTodoAction({ store: todos, actions: [jira], now: () => NOW }, id, "jira");

    expect(jira.run).toHaveBeenCalledWith(expect.objectContaining({ id, markdown: "a" }));
    expect(todos.getTodo(id)?.sent).toEqual([{ action: "jira", label: "X-1", url: "https://x/X-1", at: NOW }]);
  });

  it("should refuse an unknown action, one that isn't set up, or a deleted item, without running anything", async () => {
    const id = todos.addTodo({ markdown: "a", section: "work", source: null }, NOW);
    const notReady = action("Set up Jira in Settings first.");
    const deps = { store: todos, actions: [notReady], now: () => NOW };

    await expect(runTodoAction(deps, id, "slack")).rejects.toThrow(/isn't something/);
    await expect(runTodoAction(deps, id, "jira")).rejects.toThrow(/Set up Jira/);
    await expect(runTodoAction({ ...deps, actions: [action(null)] }, 999, "jira")).rejects.toThrow(/no longer on your list/);
    expect(notReady.run).not.toHaveBeenCalled();
  });

  it("should describe each action for the menu, saying which open a popup", () => {
    expect(describeActions([action("Set up Jira in Settings first."), { ...action(null), id: "jira-popup", dialog: "jira" }])).toEqual([
      { id: "jira", label: "Make a Jira ticket", unavailable: "Set up Jira in Settings first.", dialog: null },
      { id: "jira-popup", label: "Make a Jira ticket", unavailable: null, dialog: "jira" },
    ]);
  });

  it("should never run a popup action straight from the menu", async () => {
    const id = todos.addTodo({ markdown: "a", section: "work", source: null }, NOW);
    const popup = { ...action(null), dialog: "jira" as const };

    await expect(runTodoAction({ store: todos, actions: [popup], now: () => NOW }, id, "jira")).rejects.toThrow(/isn't something/);
    expect(popup.run).not.toHaveBeenCalled();
  });

  it("should record what a popup sent on the item under the popup's action, or refuse a deleted item", async () => {
    const id = todos.addTodo({ markdown: "a", section: "work", source: null }, NOW);
    const send = vi.fn(async () => ({ action: "ignored", label: "QI-5", url: "https://x/QI-5" }));

    await recordSent({ store: todos, now: () => NOW }, id, "jira", send);

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ id }));
    expect(todos.getTodo(id)?.sent).toEqual([{ action: "jira", label: "QI-5", url: "https://x/QI-5", at: NOW }]);
    await expect(recordSent({ store: todos, now: () => NOW }, 999, "jira", send)).rejects.toThrow(/no longer on your list/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("should accept a new item with or without a call, and refuse one too long, with a bad call or no section", () => {
    expect(assertNewTodo({ markdown: "a", section: "personal" })).toEqual({ markdown: "a", section: "personal", source: null });
    expect(assertNewTodo({ markdown: "a", section: "work", source: { recordingId: 3, title: "Sync", saidAt: NOW } })).toEqual({
      markdown: "a",
      section: "work",
      source: { recordingId: 3, title: "Sync", saidAt: NOW },
    });
    expect(() => assertNewTodo({ markdown: "x".repeat(MAX_TODO_CHARS + 1), section: "work" })).toThrow(/up to/);
    expect(() => assertNewTodo({ markdown: 3, section: "work" })).toThrow(/up to/);
    expect(() => assertNewTodo({ markdown: "a", section: "work", source: { recordingId: 3, saidAt: NOW } })).toThrow(/Not a call/);
    expect(() => assertNewTodo({ markdown: "a", section: "work", source: { recordingId: -1, title: "x", saidAt: NOW } })).toThrow();
    expect(() => assertNewTodo({ markdown: "a" })).toThrow(/Work or Personal/);
    expect(() => assertNewTodo({ markdown: "a", section: "hobby" })).toThrow(/Work or Personal/);
  });
});

describe("assertLayout", () => {
  it("should accept both sections' ids and refuse a missing section or a bad id", () => {
    expect(assertLayout({ work: [1, 2], personal: [3] })).toEqual({ work: [1, 2], personal: [3] });
    expect(() => assertLayout({ work: [1] })).toThrow(/Not a list/);
    expect(() => assertLayout([1, 2])).toThrow(/Not a list/);
    expect(() => assertLayout({ work: [1], personal: ["x"] })).toThrow();
  });
});
