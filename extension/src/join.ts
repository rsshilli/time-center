import { MARKER_PREFIX, verifyMarker } from "./joinMarker";
import { pickJoinButton } from "./pickJoinButton";

/** Remembers, for this tab, until when the extension may click (Teams moves through several pages). */
const FLAG_KEY = "timeCenterJoinUntil";

/** How long after opening the page the extension keeps looking for the Join button. */
const LOOK_FOR_MS = 2 * 60_000;

/** How often it looks, and how long it waits after a click before looking again. */
const LOOK_EVERY_MS = 1_000;
const AFTER_CLICK_MS = 3_000;

void main();

/**
 * Clicks Join on a Meet or Teams page, but only in a tab Time Center opened to join: the address carried
 * a marker signed with the key Time Center wrote into build/key.js, or an earlier page in this tab did.
 * Pages you open yourself, and pages a website sends you to, are never touched.
 */
async function main(): Promise<void> {
  const key = (self as unknown as { timeCenterKey?: string }).timeCenterKey ?? "";
  if (
    location.hash.startsWith(`#${MARKER_PREFIX}`) &&
    (await verifyMarker(location.hash, location.hostname, location.pathname, key, Date.now()))
  ) {
    sessionStorage.setItem(FLAG_KEY, String(Date.now() + LOOK_FOR_MS));
  }
  const until = Number(sessionStorage.getItem(FLAG_KEY) ?? 0);
  if (Date.now() < until) {
    lookForButton(until);
  }
}

/**
 * Looks for a button to click once a second until the meeting is joined or time runs out.
 * @param until When to give up.
 */
function lookForButton(until: number): void {
  if (Date.now() >= until) {
    sessionStorage.removeItem(FLAG_KEY);
    return;
  }
  const buttons = Array.from(document.querySelectorAll<HTMLElement>("button, [role='button']"));
  const pick = pickJoinButton(
    buttons.map((button) => ({
      labels: [button.innerText ?? "", button.getAttribute("aria-label") ?? ""],
      disabled: (button as HTMLButtonElement).disabled || button.getAttribute("aria-disabled") === "true",
    })),
  );
  if (!pick) {
    setTimeout(() => lookForButton(until), LOOK_EVERY_MS);
    return;
  }
  buttons[pick.index].click();
  if (pick.joins) {
    sessionStorage.removeItem(FLAG_KEY);
    return;
  }
  setTimeout(() => lookForButton(until), AFTER_CLICK_MS);
}
