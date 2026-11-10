import { MAX_TODO_CHARS } from "../../src/shared/ipc";
import { Store } from "../../src/main/store/Store";
import { TodoStore } from "../../src/main/todos/TodoStore";
import { type TodoAction, assertNewTodo, describeActions, runTodoAction } from "../../src/main/todos/todoIpc";

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
    const id = todos.addTodo({ markdown: "a", source: null }, NOW);
    const jira = action(null);

    await runTodoAction({ store: todos, actions: [jira], now: () => NOW }, id, "jira");

    expect(jira.run).toHaveBeenCalledWith(expect.objectContaining({ id, markdown: "a" }));
    expect(todos.getTodo(id)?.sent).toEqual([{ action: "jira", label: "X-1", url: "https://x/X-1", at: NOW }]);
  });

  it("should refuse an unknown action, one that isn't set up, or a deleted item, without running anything", async () => {
    const id = todos.addTodo({ markdown: "a", source: null }, NOW);
    const notReady = action("Set up Jira in Settings first.");
    const deps = { store: todos, actions: [notReady], now: () => NOW };

    await expect(runTodoAction(deps, id, "slack")).rejects.toThrow(/isn't something/);
    await expect(runTodoAction(deps, id, "jira")).rejects.toThrow(/Set up Jira/);
    await expect(runTodoAction({ ...deps, actions: [action(null)] }, 999, "jira")).rejects.toThrow(/no longer on your list/);
    expect(notReady.run).not.toHaveBeenCalled();
  });

  it("should describe each action for the menu", () => {
    expect(describeActions([action("Set up Jira in Settings first.")])).toEqual([
      { id: "jira", label: "Make a Jira ticket", unavailable: "Set up Jira in Settings first." },
    ]);
  });

  it("should accept a new item with or without a call, and refuse one too long or with a bad call", () => {
    expect(assertNewTodo({ markdown: "a" })).toEqual({ markdown: "a", source: null });
    expect(assertNewTodo({ markdown: "a", source: { recordingId: 3, title: "Sync", saidAt: NOW } })).toEqual({
      markdown: "a",
      source: { recordingId: 3, title: "Sync", saidAt: NOW },
    });
    expect(() => assertNewTodo({ markdown: "x".repeat(MAX_TODO_CHARS + 1) })).toThrow(/up to/);
    expect(() => assertNewTodo({ markdown: 3 })).toThrow(/up to/);
    expect(() => assertNewTodo({ markdown: "a", source: { recordingId: 3, saidAt: NOW } })).toThrow(/Not a call/);
    expect(() => assertNewTodo({ markdown: "a", source: { recordingId: -1, title: "x", saidAt: NOW } })).toThrow();
  });
});
