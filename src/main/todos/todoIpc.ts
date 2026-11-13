import { ipcMain } from "electron";
import {
  IPC,
  type JiraDraftResult,
  type JiraUser,
  type SprintTicketsReport,
  type TicketMove,
  MAX_TODO_CHARS,
  type QbdcodeHandoff,
  type TodoDialog,
  type NewTodo,
  TODO_SECTIONS,
  type Todo,
  type TodoActionInfo,
  type TodoLayout,
  type TodoSection,
  type TodoSent,
  type TodoSource,
} from "../../shared/ipc";
import { assertMoment, assertRowId } from "../ipcHandlers";
import type { TodoStore } from "./TodoStore";

/**
 * Something an item's menu can do with it, such as making a Jira ticket. A new destination ("Send to Claude
 * Desktop") is one more of these in the list handed to registerTodoIpc.
 */
export interface TodoAction {
  /** Stable id, saved with each item it was used on. */
  id: string;
  /** The menu label. */
  label: string;
  /** The popup the menu opens instead of running it. */
  dialog?: TodoDialog;
  /** Why it can't run yet, or null when it can. */
  unavailable(): string | null;
  /** Sends the item; returns where it went (the time is added for it). */
  run(todo: Todo): Promise<Omit<TodoSent, "at">>;
}

/** What the TODO requests are answered from. */
export interface TodoIpcDependencies {
  store: TodoStore;
  /** The actions on offer now (Jira's follow the ticket types saved in Settings). */
  actions(): TodoAction[];
  /** Jira's settings, read and saved. */
  getJiraSettings(): unknown;
  saveJiraSettings(input: unknown): Promise<unknown>;
  /** Has Sonnet propose a ticket for an item, or change the proposal. */
  draftJiraTicket(todo: Todo, current: unknown, instruction: unknown): Promise<JiraDraftResult>;
  searchJiraUsers(query: unknown): Promise<JiraUser[]>;
  /** Makes the ticket; returns where it went. */
  createJiraTicket(todo: Todo, draft: unknown): Promise<Omit<TodoSent, "at">>;
  /** Your Jira tickets in the open sprints. */
  getSprintTickets(): Promise<SprintTicketsReport>;
  /** The states a ticket can be moved to. */
  listTicketMoves(key: unknown): Promise<TicketMove[]>;
  /** Moves a ticket; answers with your sprint list after. */
  moveTicket(key: unknown, moveId: unknown): Promise<SprintTicketsReport>;
  /** The instructions and worktrees the QbDCode popup starts with. */
  prepareQbdcodeHandoff(todo: Todo): QbdcodeHandoff;
  /** Starts the QbDCode chat; returns where it went. */
  sendToQbdcode(worktreePath: unknown, text: unknown): Promise<Omit<TodoSent, "at">>;
  now(): number;
}

/**
 * Answers the TODO tab's requests. Each change answers with the whole list, so the window never shows a
 * stale order.
 * @param deps The services to answer from.
 */
export function registerTodoIpc(deps: TodoIpcDependencies): void {
  const list = () => deps.store.listTodos();
  ipcMain.handle(IPC.getTodos, list);
  ipcMain.handle(IPC.addTodo, (_event, todo: unknown) => {
    deps.store.addTodo(assertNewTodo(todo), deps.now());
    return list();
  });
  ipcMain.handle(IPC.updateTodo, (_event, id: unknown, markdown: unknown) => {
    deps.store.updateTodo(assertRowId(id), assertMarkdown(markdown));
    return list();
  });
  ipcMain.handle(IPC.setTodoDone, (_event, id: unknown, done: unknown) => {
    if (typeof done !== "boolean") {
      throw new Error("Say whether the item is done.");
    }
    deps.store.setDone(assertRowId(id), done, deps.now());
    return list();
  });
  ipcMain.handle(IPC.arrangeTodos, (_event, layout: unknown) => {
    deps.store.arrange(assertLayout(layout));
    return list();
  });
  ipcMain.handle(IPC.deleteTodo, (_event, id: unknown) => {
    deps.store.deleteTodo(assertRowId(id));
    return list();
  });
  ipcMain.handle(IPC.clearDoneTodos, () => {
    deps.store.clearDone();
    return list();
  });
  ipcMain.handle(IPC.getTodoActions, () => describeActions(deps.actions()));
  ipcMain.handle(IPC.runTodoAction, async (_event, id: unknown, actionId: unknown) => {
    await runTodoAction({ store: deps.store, actions: deps.actions(), now: deps.now }, assertRowId(id), actionId);
    return list();
  });
  ipcMain.handle(IPC.getJiraSettings, () => deps.getJiraSettings());
  ipcMain.handle(IPC.saveJiraSettings, (_event, input: unknown) => deps.saveJiraSettings(input));
  ipcMain.handle(IPC.draftJiraTicket, (_event, id: unknown, current: unknown, instruction: unknown) =>
    deps.draftJiraTicket(openTodo(deps.store, assertRowId(id)), current, instruction),
  );
  ipcMain.handle(IPC.searchJiraUsers, (_event, query: unknown) => deps.searchJiraUsers(query));
  ipcMain.handle(IPC.createJiraTicket, async (_event, id: unknown, draft: unknown) => {
    await recordSent(deps, assertRowId(id), "jira", (todo) => deps.createJiraTicket(todo, draft));
    return list();
  });
  ipcMain.handle(IPC.getSprintTickets, () => deps.getSprintTickets());
  ipcMain.handle(IPC.listTicketMoves, (_event, key: unknown) => deps.listTicketMoves(key));
  ipcMain.handle(IPC.moveTicket, (_event, key: unknown, moveId: unknown) => deps.moveTicket(key, moveId));
  ipcMain.handle(IPC.prepareQbdcodeHandoff,(_event, id: unknown) => deps.prepareQbdcodeHandoff(openTodo(deps.store, assertRowId(id))));
  ipcMain.handle(IPC.sendToQbdcode, async (_event, id: unknown, path: unknown, text: unknown) => {
    await recordSent(deps, assertRowId(id), "qbdcode", () => deps.sendToQbdcode(path, text));
    return list();
  });
}

/**
 * Sends an item from one of its popups and records where it went.
 * @param deps The list and the clock.
 * @param id The item.
 * @param action The popup's action, saved with the record, e.g. "jira".
 * @param send Sends the item; returns where it went.
 */
export async function recordSent(
  deps: Pick<TodoIpcDependencies, "store" | "now">,
  id: number,
  action: string,
  send: (todo: Todo) => Promise<Omit<TodoSent, "at">>,
): Promise<void> {
  const sent = await send(openTodo(deps.store, id));
  deps.store.addSent(id, { ...sent, action, at: deps.now() });
}

/**
 * An item that's still on the list.
 * @param store The list.
 * @param id The item.
 * @returns The item.
 */
function openTodo(store: Pick<TodoStore, "getTodo">, id: number): Todo {
  const todo = store.getTodo(id);
  if (!todo) {
    throw new Error("That item is no longer on your list.");
  }
  return todo;
}

/**
 * What each action is called and whether it's ready.
 * @param actions The actions.
 * @returns Their menu entries.
 */
export function describeActions(actions: TodoAction[]): TodoActionInfo[] {
  return actions.map((action) => ({ id: action.id, label: action.label, unavailable: action.unavailable(), dialog: action.dialog ?? null }));
}

/**
 * Runs a menu action on an item and records where it went.
 * @param deps The list and the actions.
 * @param id The item.
 * @param actionId The action the window asked for.
 */
export async function runTodoAction(deps: Pick<TodoIpcDependencies, "store" | "now"> & { actions: TodoAction[] }, id: number, actionId: unknown): Promise<void> {
  const action = deps.actions.find((candidate) => candidate.id === actionId);
  if (!action || action.dialog) {
    throw new Error("That isn't something an item can do.");
  }
  const unavailable = action.unavailable();
  if (unavailable) {
    throw new Error(unavailable);
  }
  const todo = openTodo(deps.store, id);
  const sent = await action.run(todo);
  deps.store.addSent(id, { ...sent, action: action.id, at: deps.now() });
}

/**
 * Checks a new item sent by the window.
 * @param value What it sent.
 * @returns The item, typed.
 */
export function assertNewTodo(value: unknown): NewTodo {
  const todo = value as Partial<NewTodo> | null;
  if (typeof todo !== "object" || todo === null) {
    throw new Error("Not an item.");
  }
  return {
    markdown: assertMarkdown(todo.markdown),
    section: assertSection(todo.section),
    source: todo.source === null || todo.source === undefined ? null : assertSource(todo.source),
  };
}

/**
 * Checks the sections and order sent by the window after a drag.
 * @param value What it sent.
 * @returns Each section's items, typed.
 */
export function assertLayout(value: unknown): TodoLayout {
  const layout = value as Partial<Record<TodoSection, unknown>> | null;
  if (typeof layout !== "object" || layout === null) {
    throw new Error("Not a list of items.");
  }
  const checked = {} as TodoLayout;
  for (const section of TODO_SECTIONS) {
    const ids = layout[section];
    if (!Array.isArray(ids) || ids.length > 10_000) {
      throw new Error("Not a list of items.");
    }
    checked[section] = ids.map(assertRowId);
  }
  return checked;
}

/**
 * Checks an item's text.
 * @param value What the window sent.
 * @returns The text, without the blank lines and spaces around it.
 */
function assertMarkdown(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_TODO_CHARS) {
    throw new Error(`An item can be up to ${MAX_TODO_CHARS} characters.`);
  }
  return value.trim();
}

/**
 * Checks which section a new item goes in.
 * @param value What the window sent.
 * @returns The section.
 */
function assertSection(value: unknown): TodoSection {
  if (!TODO_SECTIONS.includes(value as TodoSection)) {
    throw new Error("An item goes in Work or Personal.");
  }
  return value as TodoSection;
}

/**
 * Checks the call an item came from.
 * @param value What the window sent.
 * @returns The source.
 */
function assertSource(value: unknown): TodoSource {
  const source = value as Partial<TodoSource>;
  if (typeof source !== "object" || typeof source.title !== "string" || source.title.length > 500) {
    throw new Error("Not a call.");
  }
  return {
    recordingId: source.recordingId === null ? null : assertRowId(source.recordingId),
    title: source.title,
    saidAt: assertMoment(source.saidAt),
  };
}
