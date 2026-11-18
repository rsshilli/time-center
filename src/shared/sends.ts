import type { TodoSent } from "./ipc";

/**
 * Adds a send to a list of where something was sent, keeping one entry per place: sending again to the same place
 * (the same Cowork task list, the same QbDCode worktree, the same Jira ticket) replaces the earlier entry with this
 * one, so it shows once, with the latest time.
 * @param list The sends so far.
 * @param sent The new one.
 * @returns The list with it, newest last.
 */
export function withSend(list: readonly TodoSent[], sent: TodoSent): TodoSent[] {
  return [...list.filter((each) => !samePlace(each, sent)), sent];
}

/**
 * One entry per place, the latest kept, for lists saved before sends were merged.
 * @param list The sends.
 * @returns The list with repeats taken out, in the order each place was last sent to.
 */
export function uniqueSends(list: readonly TodoSent[]): TodoSent[] {
  return list.reduce<TodoSent[]>((kept, sent) => withSend(kept, sent), []);
}

/**
 * Whether two sends went to the same place.
 * @param a One.
 * @param b The other.
 * @returns True when the action, its label and its link all match.
 */
function samePlace(a: TodoSent, b: TodoSent): boolean {
  return a.action === b.action && a.label === b.label && a.url === b.url;
}
