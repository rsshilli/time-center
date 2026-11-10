import { isAllowedUri } from "@tiptap/extension-link";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { Placeholder } from "@tiptap/extensions";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";

/** How long after you stop typing an edited item is saved. */
const SAVE_AFTER_MS = 800;

/** What the editor needs from the item it shows. */
interface TodoEditorProps {
  /** The item as Markdown. */
  markdown: string;
  editable: boolean;
  placeholder?: string;
  /** Called with the new Markdown when you pause typing or leave the item; answers whether it was saved. */
  onSave?(markdown: string): Promise<boolean>;
  /** For the new-item box: Enter (outside a list or code block) adds the item. */
  onSubmit?(markdown: string): void;
  /** Lets the parent clear the new-item box after adding. */
  editorRef?: { current: Editor | null };
}

/**
 * One item's text, formatted as you type and saved as Markdown: **bold**, _italics_, `code`, lists and links.
 * Select words and press ⌘K (or the link button) to link them; pasting an address over selected words does
 * the same. With the cursor in a link, a bar under the item opens, changes or removes it.
 */
export function TodoEditor({ markdown, editable, placeholder, onSave, onSubmit, editorRef }: TodoEditorProps) {
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  // The item's text as last loaded or sent, and the editor's own Markdown for it. They can differ (the editor
  // writes _x_ as *x*), so only a change from `baseline` counts as an edit worth saving.
  const loaded = useRef(markdown);
  const baseline = useRef<string | null>(null);
  // Saves still waiting for an answer; an earlier save's answer mustn't reset newer text on screen.
  const saving = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlers = useRef({ onSave, onSubmit });
  handlers.current = { onSave, onSubmit };
  const keyHandler = useRef<(event: KeyboardEvent) => boolean>(() => false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: {
          openOnClick: !editable,
          autolink: true,
          linkOnPaste: true,
          defaultProtocol: "https",
          HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" },
        },
      }),
      // Sub-steps you tick off one by one, saved as "- [ ] step" / "- [x] step"; Tab nests one under another.
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown,
      Placeholder.configure({ placeholder: placeholder ?? "" }),
    ],
    content: markdown,
    contentType: "markdown",
    editable,
    editorProps: { handleKeyDown: (_view, event) => keyHandler.current(event) },
    onCreate: ({ editor: created }) => {
      baseline.current = created.getMarkdown();
    },
    onUpdate: () => {
      scheduleSave();
    },
    onBlur: () => {
      flushSave();
    },
  });

  /** Saves a moment after the last keystroke, so a slow typist isn't saving on every letter. */
  const scheduleSave = () => {
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(flushSave, SAVE_AFTER_MS);
  };

  /** Saves now if the text changed since the last save. If the save fails, the next pause or blur tries again. */
  const flushSave = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const current = editor?.getMarkdown();
    if (!handlers.current.onSave || current === undefined || current === baseline.current) {
      return;
    }
    const before = { loaded: loaded.current, baseline: baseline.current };
    loaded.current = current;
    baseline.current = current;
    saving.current += 1;
    void handlers.current.onSave(current).then((ok) => {
      saving.current -= 1;
      if (!ok && baseline.current === current) {
        loaded.current = before.loaded;
        baseline.current = before.baseline;
      }
    });
  };

  /** Opens the link bar on the selection's link, or an empty one for selected words. */
  const startLink = () => {
    if (!editor) {
      return;
    }
    const href = editor.getAttributes("link").href as string | undefined;
    if (!href && editor.state.selection.empty) {
      return;
    }
    if (href) {
      editor.chain().focus().extendMarkRange("link").run();
    }
    setLinkUrl(href ?? "");
  };

  keyHandler.current = (event) => {
    if (!editor) {
      return false;
    }
    if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      startLink();
      return true;
    }
    const inBlock =
      editor.isActive("bulletList") || editor.isActive("orderedList") || editor.isActive("taskList") || editor.isActive("codeBlock");
    if (handlers.current.onSubmit && event.key === "Enter" && !event.shiftKey && !event.isComposing && !inBlock) {
      event.preventDefault();
      handlers.current.onSubmit(editor.getMarkdown());
      return true;
    }
    return false;
  };

  useEffect(() => {
    if (editorRef) {
      editorRef.current = editor;
    }
  }, [editor, editorRef]);

  useEffect(() => {
    // No update event: opening or ticking an item isn't an edit, so nothing is saved.
    editor?.setEditable(editable, false);
  }, [editor, editable]);

  useEffect(() => {
    // The list was reloaded with different text (e.g. edited elsewhere): show it, unless you're typing here.
    if (editor && !editor.isFocused && saving.current === 0 && markdown !== loaded.current) {
      loaded.current = markdown;
      editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false });
      baseline.current = editor.getMarkdown();
    }
  }, [editor, markdown]);

  useEffect(
    () => () => {
      // Leaving the screen mid-edit still saves what was typed.
      flushSave();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor],
  );

  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      focused: current?.isFocused ?? false,
      inLink: current?.isActive("link") ?? false,
      href: (current?.getAttributes("link").href as string | undefined) ?? null,
      bold: current?.isActive("bold") ?? false,
      italic: current?.isActive("italic") ?? false,
      code: current?.isActive("code") ?? false,
      bullets: current?.isActive("bulletList") ?? false,
      steps: current?.isActive("taskList") ?? false,
    }),
  });

  if (!editor) {
    return null;
  }

  /** Puts the typed address on the selected words, or removes the link when it's emptied. */
  const applyLink = () => {
    const url = (linkUrl ?? "").trim();
    if (!url) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
      const href = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    setLinkUrl(null);
  };

  return (
    <div className={editable ? "todo-editor editable" : "todo-editor"}>
      <EditorContent editor={editor} />
      {editable && (state?.focused || linkUrl !== null) && (
        <div className="todo-toolbar" onMouseDown={(event) => event.preventDefault()}>
          <button type="button" className={state?.bold ? "on" : ""} title="Bold (⌘B)" onClick={() => editor.chain().focus().toggleBold().run()}>
            <b>B</b>
          </button>
          <button type="button" className={state?.italic ? "on" : ""} title="Italics (⌘I)" onClick={() => editor.chain().focus().toggleItalic().run()}>
            <i>I</i>
          </button>
          <button type="button" className={state?.code ? "on" : ""} title="Code (⌘E)" onClick={() => editor.chain().focus().toggleCode().run()}>
            {"</>"}
          </button>
          <button type="button" className={state?.bullets ? "on" : ""} title="Bullet list" onClick={() => editor.chain().focus().toggleBulletList().run()}>
            • List
          </button>
          <button
            type="button"
            className={state?.steps ? "on" : ""}
            title="Sub-steps to tick off (Tab nests a step under the one above)"
            onClick={() => editor.chain().focus().toggleTaskList().run()}
          >
            ☑ Steps
          </button>
          <button type="button" className={state?.inLink ? "on" : ""} title="Link the selected words (⌘K)" onClick={startLink}>
            Link
          </button>
          {state?.inLink && state.href && isAllowedUri(state.href) && linkUrl === null && (
            <span className="todo-link-info">
              <a href={state.href} target="_blank" rel="noopener noreferrer">
                {state.href}
              </a>
              <button type="button" onClick={() => editor.chain().focus().extendMarkRange("link").unsetLink().run()}>
                Remove link
              </button>
            </span>
          )}
        </div>
      )}
      {linkUrl !== null && (
        <form
          className="todo-link-bar"
          onSubmit={(event) => {
            event.preventDefault();
            applyLink();
          }}
        >
          <input
            autoFocus
            type="text"
            placeholder="Paste or type an address"
            value={linkUrl}
            onChange={(event) => setLinkUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setLinkUrl(null);
                editor.commands.focus();
              }
            }}
          />
          <button type="submit">Link</button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setLinkUrl(null);
              editor.commands.focus();
            }}
          >
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}
