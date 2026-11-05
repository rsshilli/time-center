/** A button on the page, as the picker sees it. */
export interface ButtonCandidate {
  /** Its visible text and its accessible name; either may match. */
  labels: string[];
  disabled: boolean;
}

/** What to click: the button's position in the list, and whether that click joins the meeting. */
export interface Pick {
  index: number;
  joins: boolean;
}

/**
 * Buttons that join the meeting, matched by their whole label so "Join now" never matches a "Join now
 * from another device" link. Meet: "Join now", or "Ask to join" when someone has to let you in. Teams:
 * "Join now" on its pre-join screen.
 */
const JOIN_LABELS = ["join now", "ask to join", "join anyway"];

/** Buttons that lead to the join screen: Teams' launcher page offers the app or the browser first. */
const STEP_LABELS = ["continue on this browser", "join on the web instead", "use the web app instead"];

/**
 * Picks the button to click on a Meet or Teams page: a join button if there is one, otherwise a button
 * that leads to the join screen. Labels are compared whole, case and spacing ignored, and disabled
 * buttons (Meet greys out Join until the camera check finishes) are passed over.
 * @param buttons The page's buttons, in page order.
 * @returns What to click, or null when nothing matches yet.
 */
export function pickJoinButton(buttons: ButtonCandidate[]): Pick | null {
  for (const [labels, joins] of [
    [JOIN_LABELS, true],
    [STEP_LABELS, false],
  ] as const) {
    const index = buttons.findIndex(
      (button) => !button.disabled && button.labels.some((label) => labels.includes(normalise(label))),
    );
    if (index >= 0) {
      return { index, joins };
    }
  }
  return null;
}

/**
 * Lower-cases a label and squeezes its spacing.
 * @param label The label.
 * @returns e.g. "join now".
 */
function normalise(label: string): string {
  return label.replace(/\s+/g, " ").trim().toLowerCase();
}
