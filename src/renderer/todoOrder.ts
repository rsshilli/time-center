import { TODO_SECTIONS, type TodoLayout, type TodoSection } from "../shared/ipc";

/**
 * The new sections after a drag. Dropped on an item in its own section, it takes that item's place (see
 * moveItem); dropped on an item in the other section, it goes just above it; dropped on a section's empty
 * space, it goes to the end of that section.
 * @param layout Each section's items, in order.
 * @param moved The dragged item.
 * @param section The section it was dropped in.
 * @param target The item it was dropped on, or null for the section's empty space.
 * @returns The new layout, or the same one when nothing moved.
 */
export function moveTodo(layout: TodoLayout, moved: number, section: TodoSection, target: number | null): TodoLayout {
  const from = TODO_SECTIONS.find((candidate) => layout[candidate].includes(moved));
  if (!from || target === moved || (target !== null && !layout[section].includes(target))) {
    return layout;
  }
  if (from === section) {
    const ids = layout[section];
    if (target === null) {
      return ids.at(-1) === moved ? layout : { ...layout, [section]: [...ids.filter((id) => id !== moved), moved] };
    }
    const next = moveItem(ids, moved, target);
    return next === ids ? layout : { ...layout, [section]: next };
  }
  const into = [...layout[section]];
  into.splice(target === null ? into.length : into.indexOf(target), 0, moved);
  return { ...layout, [from]: layout[from].filter((id) => id !== moved), [section]: into };
}

/**
 * The new order after dragging one item onto another: it takes the target's place, and the items between
 * shift up or down one.
 * @param ids The current order.
 * @param moved The dragged item.
 * @param target The item it was dropped on.
 * @returns The new order, or the same order when either isn't in the list.
 */
export function moveItem(ids: number[], moved: number, target: number): number[] {
  const from = ids.indexOf(moved);
  const to = ids.indexOf(target);
  if (from === -1 || to === -1 || from === to) {
    return ids;
  }
  const next = ids.filter((id) => id !== moved);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Plain text made safe to use as Markdown, so an action item such as "update *config*" keeps its stars.
 * @param text The text.
 * @returns It with Markdown's special characters escaped.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]<>~|#])/g, "\\$1");
}

/**
 * How far through its sub-steps (checkbox lines, "- [ ]" / "- [x]", at any depth) an item is.
 * @param markdown The item.
 * @returns Steps ticked and in all, or null when it has none.
 */
export function stepProgress(markdown: string): { done: number; total: number } | null {
  const steps = markdown.match(/^\s*[-*+]\s+\[[ xX]\]/gm) ?? [];
  if (steps.length === 0) {
    return null;
  }
  return { done: steps.filter((step) => /\[[xX]\]/.test(step)).length, total: steps.length };
}

/**
 * Whether a TODO's Markdown has any words, so an empty new item isn't added.
 * @param markdown The item.
 * @returns True when there's more than whitespace and list or heading markers.
 */
export function hasWords(markdown: string): boolean {
  return markdown.replace(/[\s>#*_`~\-+[\]()]|&nbsp;|\\/g, "").length > 0;
}
