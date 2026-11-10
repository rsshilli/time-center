import type { Editor } from "@tiptap/react";
import { type DragEvent, useEffect, useRef, useState } from "react";
import { TODO_SECTIONS, type Todo, type TodoActionInfo, type TodoLayout, type TodoSection } from "../shared/ipc";
import { readableError } from "./CalendarSettings";
import { TodoEditor } from "./TodoEditor";
import { hasWords, moveTodo, stepProgress } from "./todoOrder";

/** What the TODO screen needs from the window around it. */
interface TodosScreenProps {
  /** Opens the Recordings tab on the day of a call an item came from. */
  onOpenCall(at: number): void;
}

/** What each section is called on screen. */
const SECTION_NAMES: Record<TodoSection, string> = { work: "Work", personal: "Personal" };

/**
 * The TODO list: a Work and a Personal section, each with a box to add an item at its top and its items
 * still to do (tick, edit in place, drag ⋮⋮ to reorder or into the other section, ⋯ for more, such as making
 * a Jira ticket), and the done items of both folded away below.
 */
export function TodosScreen({ onOpenCall }: TodosScreenProps) {
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [actions, setActions] = useState<TodoActionInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  if (!todos) {
    return error ? <p className="error">{error}</p> : null;
  }
  const open = todos.filter((todo) => todo.doneAt === null);
  const done = todos.filter((todo) => todo.doneAt !== null);

  return (
    <section className="todos">
      <h1>TODOs</h1>
      <p className="lead">
        Type an item and press Enter. Format as you go: **bold**, _italics_, `code`, "- " for a list, "[ ] " (or ☑ Steps)
        for sub-steps to tick off, Tab to nest one. Select words and press ⌘K to link them, or paste an address over them.
        Drag an item's ⋮⋮ to reorder it or move it between Work and Personal.
      </p>
      {error && <p className="error">{error}</p>}
      <TodoBoard todos={open} actions={actions} update={update} onOpenCall={onOpenCall} />
      {done.length > 0 && (
        <details className="todo-done">
          <summary>
            Done ({done.length})
          </summary>
          <ul className="todo-list">
            {done.map((todo) => (
              <TodoRow key={`${todo.id}-done`} todo={todo} actions={actions} update={update} onOpenCall={onOpenCall} showSection />
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

/** Where a dragged item is hovering: over an item, or (target null) over a section's empty space. */
interface DropSpot {
  section: TodoSection;
  target: number | null;
}

/**
 * The items still to do, in their Work and Personal sections. Dragging an item's ⋮⋮ handle onto another item
 * moves it there; onto a section's heading or Add box, to its top; onto its other empty space, to its end.
 * @param props The items, the menu actions and how to change the list.
 */
function TodoBoard({ todos, ...rest }: RowProps & { todos: Todo[] }) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<DropSpot | null>(null);
  const layout = Object.fromEntries(
    TODO_SECTIONS.map((section) => [section, todos.filter((todo) => todo.section === section).map((todo) => todo.id)]),
  ) as TodoLayout;

  /** Forgets the drag, whether it was dropped or let go elsewhere. */
  const endDrag = () => {
    setDragging(null);
    setOver(null);
  };

  /**
   * Drops the dragged item and saves the new sections and order.
   * @param spot Where it was dropped.
   */
  const drop = (spot: DropSpot) => {
    const next = dragging === null ? layout : moveTodo(layout, dragging, spot.section, spot.target);
    endDrag();
    if (next !== layout) {
      void rest.update(() => window.timeCenter.arrangeTodos(next));
    }
  };

  /**
   * Where a drop on a section's own space lands: its heading and Add box mean the top (taking the first item's
   * place), anywhere else the end.
   * @param section The section.
   * @param atTop Whether it's over the heading or Add box.
   * @returns The spot.
   */
  const sectionSpot = (section: TodoSection, atTop: boolean): DropSpot => ({ section, target: atTop ? (layout[section][0] ?? null) : null });

  return (
    <div
      className="todo-board"
      onDragLeave={(event) => {
        // Dragged out of the board (onto the Done fold, or off the window): nothing is the drop spot any more.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOver(null);
        }
      }}
    >
      {TODO_SECTIONS.map((section) => (
        <TodoSectionView
          key={section}
          section={section}
          todos={todos.filter((todo) => todo.section === section)}
          {...rest}
          active={dragging !== null}
          dropping={dragging !== null && over?.section === section && over.target === null}
          onOver={(atTop) => setOver(sectionSpot(section, atTop))}
          onDrop={(atTop) => drop(sectionSpot(section, atTop))}
          dragFor={(todo) => ({
            active: dragging !== null,
            dragging: dragging === todo.id,
            over: dragging !== null && over?.target === todo.id && dragging !== todo.id,
            onStart: () => setDragging(todo.id),
            onOver: () => setOver({ section, target: todo.id }),
            onDrop: () => drop({ section, target: todo.id }),
            onEnd: endDrag,
          })}
        />
      ))}
    </div>
  );
}

/** What one section needs from the board around it. */
interface SectionProps extends RowProps {
  section: TodoSection;
  todos: Todo[];
  /** Whether one of the list's items is being dragged; other drags (a file from Finder) aren't dropped here. */
  active: boolean;
  /** Whether an item is being dragged over the section's empty space. */
  dropping: boolean;
  /** An item is over the section's own space: its heading and Add box (atTop), or below its items. */
  onOver(atTop: boolean): void;
  onDrop(atTop: boolean): void;
  /** How each of its rows takes part in dragging. */
  dragFor(todo: Todo): DragProps;
}

/**
 * One section: its name, a box to add an item at its top, and its items. The whole section is a drop spot,
 * so an item can be dragged into it even when it's empty.
 * @param props The section, its items and how to drag them.
 */
function TodoSectionView({ section, todos, active, dropping, onOver, onDrop, dragFor, ...rest }: SectionProps) {
  const newItem = useRef<Editor | null>(null);
  const name = SECTION_NAMES[section];

  /**
   * Adds the box's text at the top of this section, then empties the box; if it couldn't be added, the text stays.
   * @param markdown What was typed.
   */
  const add = async (markdown: string) => {
    if (!hasWords(markdown)) {
      return;
    }
    if (await rest.update(() => window.timeCenter.addTodo({ markdown, section, source: null }))) {
      newItem.current?.commands.clearContent();
    }
  };

  /**
   * Makes an element a drop spot for the section's own space.
   * @param atTop Whether a drop there goes to the top of the section rather than the end.
   * @returns Its drag handlers.
   */
  const dropSpot = (atTop: boolean) => ({
    onDragOver: (event: DragEvent) => {
      if (active) {
        // Stopped so the heading's "top" isn't overwritten by the section's "end" around it.
        event.preventDefault();
        event.stopPropagation();
        onOver(atTop);
      }
    },
    onDrop: (event: DragEvent) => {
      if (active) {
        event.preventDefault();
        event.stopPropagation();
        onDrop(atTop);
      }
    },
  });

  return (
    <section className={dropping ? "todo-section drop-target" : "todo-section"} aria-label={name} {...dropSpot(false)}>
      <div {...dropSpot(true)}>
        <h2>
          {name} <span className="muted">{todos.length}</span>
        </h2>
        <div className="todo-new">
          <TodoEditor markdown="" editable placeholder={`Add a ${name.toLowerCase()} TODO…`} onSubmit={(markdown) => void add(markdown)} editorRef={newItem} />
          <button type="button" onClick={() => void add(newItem.current?.getMarkdown() ?? "")}>
            Add
          </button>
        </div>
      </div>
      {todos.length === 0 ? (
        <p className="muted todo-empty">
          {section === "work" ? "Nothing to do. Add an item above, or from a call's action items on the Recordings tab." : "Nothing to do."} Or drag an item here.
        </p>
      ) : (
        <ul className="todo-list">
          {todos.map((todo) => (
            <TodoRow key={`${todo.id}-open`} todo={todo} {...rest} drag={dragFor(todo)} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** How a row takes part in dragging; absent for done items, which keep no order. */
interface DragProps {
  /** Whether one of the list's items is being dragged at all. */
  active: boolean;
  dragging: boolean;
  over: boolean;
  onStart(): void;
  onOver(): void;
  onDrop(): void;
  onEnd(): void;
}

/**
 * One item: its tick box, its text (editable while it's still to do), its section (in the Done fold), where
 * it came from and where it went, and its ⋯ menu.
 * @param props The item and what the row can do.
 */
function TodoRow({ todo, actions, update, onOpenCall, drag, showSection }: RowProps & { todo: Todo; drag?: DragProps; showSection?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Only the ⋮⋮ handle starts a drag, so selecting words in the item still works.
  const [handleHeld, setHandleHeld] = useState(false);
  const done = todo.doneAt !== null;
  const steps = stepProgress(todo.markdown);

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
        if (drag?.active) {
          // Stopped here so the section around the row doesn't take the drop for its empty space.
          event.preventDefault();
          event.stopPropagation();
          drag.onOver();
        }
      }}
      onDrop={(event) => {
        if (drag?.active) {
          event.preventDefault();
          event.stopPropagation();
          drag.onDrop();
        }
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
        {(showSection || steps || todo.source || todo.sent.length > 0 || running || problem) && (
          <div className="todo-meta">
            {showSection && <span className={`todo-section-tag ${todo.section}`}>{SECTION_NAMES[todo.section]}</span>}
            {steps && (
              <span className={steps.done === steps.total ? "todo-steps all-done" : "todo-steps"}>
                {steps.done} of {steps.total} steps
              </span>
            )}
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
