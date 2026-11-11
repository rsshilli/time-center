import type { JiraSprint } from "./ipc";

/**
 * The sprint a new ticket for a team goes into: the team's next sprint, the first of its sprints that hasn't
 * started by the calendar. A sprint whose start date has passed counts as under way even when Jira hasn't started
 * it yet, so a new ticket lands in the one after. A team whose coming sprints have no dates yet gets the first
 * of those made.
 * @param sprints The project's open sprints.
 * @param team The ticket's Engineering Team, or null.
 * @param now The current time.
 * @returns The sprint's id, or null when the team has no sprint to come (or there's no team).
 */
export function nextSprint(sprints: readonly JiraSprint[], team: string | null, now: number): number | null {
  if (team === null) {
    return null;
  }
  const coming = sprints.filter((sprint) => sprint.team === team && sprint.state === "future");
  const dated = coming.filter((sprint) => sprint.start !== null && sprint.start > now).sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const undated = coming.filter((sprint) => sprint.start === null).sort((a, b) => a.id - b.id);
  return (dated[0] ?? undated[0])?.id ?? null;
}

/**
 * Whether a sprint is going on now by its dates, whatever Jira says: Jira can leave a finished sprint "active"
 * and an under-way one "future" until someone presses start or complete.
 * @param sprint The sprint.
 * @param now The current time.
 * @returns True between its start and end dates.
 */
export function isUnderWay(sprint: JiraSprint, now: number): boolean {
  return sprint.start !== null && sprint.end !== null && sprint.start <= now && now < sprint.end;
}

/**
 * Finds whose sprint it is from its name: the team whose name it starts with, ignoring case, spaces and
 * punctuation ("Platform - November" is Platform's, "PØD-2026-22" PØD's).
 * @param name The sprint's name.
 * @param teams The Engineering Teams.
 * @returns The team, or null when no team's name starts it.
 */
export function sprintTeam(name: string, teams: readonly string[]): string | null {
  /** A name as letters and digits only, in lower case. */
  const squash = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const squashed = squash(name);
  // The longest name first, so "Dream Team" isn't taken for a shorter team that starts the same way.
  const match = [...teams].filter((team) => squash(team) !== "").sort((a, b) => b.length - a.length).find((team) => squashed.startsWith(squash(team)));
  return match ?? null;
}
