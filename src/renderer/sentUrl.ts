import { COWORK_URL, type TodoSent } from "../shared/ipc";

/**
 * Where a "sent to" tag under a TODO or a Jira ticket links. Sends to Cowork saved before it had a link get the
 * Cowork one too.
 * @param sent Where it was sent.
 * @returns The link, or null for a plain tag.
 */
export function sentUrl(sent: TodoSent): string | null {
  return sent.url ?? (sent.action === "cowork" ? COWORK_URL : null);
}
