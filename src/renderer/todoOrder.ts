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
 * Whether a TODO's Markdown has any words, so an empty new item isn't added.
 * @param markdown The item.
 * @returns True when there's more than whitespace and list or heading markers.
 */
export function hasWords(markdown: string): boolean {
  return markdown.replace(/[\s>#*_`~\-+[\]()]|&nbsp;|\\/g, "").length > 0;
}
