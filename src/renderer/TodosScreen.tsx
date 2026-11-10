import type { Editor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import type { Todo, TodoActionInfo } from "../shared/ipc";
import { readableError } from "./CalendarSettings";
import { TodoEditor } from "./TodoEditor";
import { hasWords, moveItem } from "./todoOrder";

/** What the TODO screen needs from the window around it. */
interface TodosScreenProps {
  /** Opens the Recordings tab on the day of a call an item came from. */
  onOpenCall(at: number): void;
}

/**
 * The TODO list: a box to add an item at the top, the items still to do (tick, edit in place, drag ⋮⋮ to
 * reorder, ⋯ for more, such as making a Jira ticket), and the done items folded away below.
 */
export function TodosScreen({ onOpenCall }: TodosScreenProps) {
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [actions, setActions] = useState<TodoActionInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const newItem = useRef<Editor | null>(null);

  useEffect(() => {
    void window.timeCenter.getTodos().then(setTodos, (failure: unknown) => setError(readableError(failure)));
    void window.timeCenter.getTodoActions().then(setActions);
  }, []);

  /**
   * Runs a change and shows the list it answers with, or the reason it failed.
   * @param change The request.
   * @returns Whether it worked.
   */
  const update = async (change: () => Promise<Todo[]>): Promise<boolean> => {
    try {
      setTodos(await change());
      setError(null);
      return true;
    } catch (failure) {
      setError(readableError(failure));
      return false;
    }
  };

  /**
   * Adds the new-item box's text at the top, then empties the box; if it couldn't be added, the text stays.
   * @param markdown What was typed.
   */
  const add = async (markdown: string) => {
    if (!hasWords(markdown)) {
      return;
    }
    if (await update(() => window.timeCenter.addTodo({ markdown, source: null }))) {
      newItem.current?.commands.clearContent();
    }
  };

  if (!todos) {
    return error ? <p className="error">{error}</p> : null;
  }
  const open = todos.filter((todo) => todo.doneAt === null);
  const done = todos.filter((todo) => todo.doneAt !== null);

  return (
    <section className="todos">
      <h1>TODOs</h1>
      <p className="lead">
        Type an item and press Enter. Format as you go: **bold**, _italics_, `code`, "- " for a list. Select words and
        press ⌘K to link them, or paste an address over them.
      </p>
      <div className="todo-new">
        <TodoEditor markdown="" editable placeholder="Add a TODO…" onSubmit={(markdown) => void add(markdown)} editorRef={newItem} />
        <button type="button" onClick={() => void add(newItem.current?.getMarkdown() ?? "")}>
          Add
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {open.length === 0 ? (
        <p className="muted todo-empty">Nothing to do. Add an item above, or from a call's action items on the Recordings tab.</p>
      ) : (
        <TodoList todos={open} actions={actions} update={update} onOpenCall={onOpenCall} />
      )}
      {done.length > 0 && (
        <details className="todo-done">
          <summary>
            Done ({done.length})
          </summary>
          <ul className="todo-list">
            {done.map((todo) => (
              <TodoRow key={`${todo.id}-done`} todo={todo} actions={actions} update={update} onOpenCall={onOpenCall} />
            ))}
          </ul>
          <button type="button" className="secondary" onClick={() => void update(() => window.timeCenter.clearDoneTodos())}>
            Clear done items
          </button>
        </details>
      )}
    </section>
  );
}

/** The props every row and list gets. */
interface RowProps {
  actions: TodoActionInfo[];
  update(change: () => Promise<Todo[]>): Promise<boolean>;
  onOpenCall(at: number): void;
}

/**
 * The items still to do, reordered by dragging an item's ⋮⋮ handle onto another item.
 * @param props The items, the menu actions and how to change the list.
 */
function TodoList({ todos, ...rest }: RowProps & { todos: Todo[] }) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  /**
   * Drops the dragged item onto another and saves the new order.
   * @param target The item it was dropped on.
   */
  const drop = (target: number) => {
    const ids = todos.map((todo) => todo.id);
    const next = dragging === null ? ids : moveItem(ids, dragging, target);
    setDragging(null);
    setOver(null);
    if (next !== ids) {
      void rest.update(() => window.timeCenter.reorderTodos(next));
    }
  };

  return (
    <ul className="todo-list">
      {todos.map((todo) => (
        <TodoRow
          key={`${todo.id}-open`}
          todo={todo}
          {...rest}
          drag={{
            dragging: dragging === todo.id,
            over: over === todo.id && dragging !== todo.id,
            onStart: () => setDragging(todo.id),
            onOver: () => setOver(todo.id),
            onDrop: () => drop(todo.id),
            onEnd: () => {
              setDragging(null);
              setOver(null);
            },
          }}
        />
      ))}
    </ul>
  );
}

/** How a row takes part in dragging; absent for done items, which keep no order. */
interface DragProps {
  dragging: boolean;
  over: boolean;
  onStart(): void;
  onOver(): void;
  onDrop(): void;
  onEnd(): void;
}

/**
 * One item: its tick box, its text (editable while it's still to do), where it came from and where it went,
 * and its ⋯ menu.
 * @param props The item and what the row can do.
 */
function TodoRow({ todo, actions, update, onOpenCall, drag }: RowProps & { todo: Todo; drag?: DragProps }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Only the ⋮⋮ handle starts a drag, so selecting words in the item still works.
  const [handleHeld, setHandleHeld] = useState(false);
  const done = todo.doneAt !== null;

  useEffect(() => {
    if (!handleHeld) {
      return undefined;
    }
    // Let go anywhere (not only on the handle) and the row stops being draggable, so words can be selected again.
    const release = () => setHandleHeld(false);
    window.addEventListener("mouseup", release);
    return () => window.removeEventListener("mouseup", release);
  }, [handleHeld]);

  /**
   * Runs a menu action, showing that it's working and any error on the row.
   * @param action The action.
   */
  const run = async (action: TodoActionInfo) => {
    setMenuOpen(false);
    setRunning(action.label);
    setProblem(null);
    try {
      await update(async () => {
        try {
          return await window.timeCenter.runTodoAction(todo.id, action.id);
        } catch (failure) {
          setProblem(readableError(failure));
          return window.timeCenter.getTodos();
        }
      });
    } finally {
      setRunning(null);
    }
  };

  const classes = ["todo-row", done ? "done" : "", drag?.dragging ? "dragging" : "", drag?.over ? "drop-target" : ""].filter(Boolean).join(" ");
  return (
    <li
      className={classes}
      draggable={Boolean(drag) && handleHeld}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        drag?.onStart();
      }}
      onDragOver={(event) => {
        if (drag) {
          event.preventDefault();
          drag.onOver();
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        drag?.onDrop();
      }}
      onDragEnd={() => {
        setHandleHeld(false);
        drag?.onEnd();
      }}
    >
      {drag ? (
        <span className="todo-handle" title="Drag to reorder" onMouseDown={() => setHandleHeld(true)}>
          ⋮⋮
        </span>
      ) : (
        <span className="todo-handle placeholder" />
      )}
      <input
        type="checkbox"
        className="todo-check"
        checked={done}
        aria-label={done ? "Mark as not done" : "Mark as done"}
        onChange={(event) => void update(() => window.timeCenter.setTodoDone(todo.id, event.target.checked))}
      />
      <div className="todo-body">
        <TodoEditor
          markdown={todo.markdown}
          editable={!done}
          onSave={(markdown) => update(() => window.timeCenter.updateTodo(todo.id, markdown))}
        />
        {(todo.source || todo.sent.length > 0 || running || problem) && (
          <div className="todo-meta">
            {todo.source && (
              <button type="button" className="link todo-source" onClick={() => onOpenCall(todo.source?.saidAt ?? Date.now())}>
                From {todo.source.title} · {new Date(todo.source.saidAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </button>
            )}
            {todo.sent.map((sent) =>
              sent.url ? (
                <a key={`${sent.action}-${sent.at}`} className="todo-sent" href={sent.url} target="_blank" rel="noopener noreferrer">
                  {sent.label} ↗
                </a>
              ) : (
                <span key={`${sent.action}-${sent.at}`} className="todo-sent">
                  {sent.label}
                </span>
              ),
            )}
            {running && <span className="muted">{running}…</span>}
            {problem && <span className="error">{problem}</span>}
          </div>
        )}
      </div>
      <div className="todo-menu">
        <button type="button" className="todo-menu-button" aria-label="More" onClick={() => setMenuOpen(!menuOpen)}>
          ⋯
        </button>
        {menuOpen && (
          <div className="todo-menu-list" onMouseLeave={() => setMenuOpen(false)}>
            {actions.map((action) => (
              <button key={action.id} type="button" disabled={action.unavailable !== null || running !== null} title={action.unavailable ?? ""} onClick={() => void run(action)}>
                {action.label}
                {action.unavailable && <span className="muted"> — {action.unavailable}</span>}
              </button>
            ))}
            <button type="button" className="danger" onClick={() => void update(() => window.timeCenter.deleteTodo(todo.id))}>
              Delete
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
