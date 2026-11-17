import { useState, type ReactElement } from "react";
import type { SuggestionRef } from "../shared/ipc";
import { readableError } from "./CalendarSettings";

/** What a list of suggested TODOs gets to dismiss them and undo it. */
export interface Dismissals<T> {
  /** The suggestions to show: those passed in, less the ones just dismissed, plus any brought back by Undo. */
  shown: T[];
  /** Dismisses a suggestion: hidden at once and saved, with Undo offered. */
  dismiss(item: T): void;
  /** Whether any were dismissed here, so an empty list can say "All dismissed." rather than "None". */
  anyDismissed: boolean;
  /** The bar under the list saying what was dismissed, with Undo; null when there's nothing to say. */
  note: ReactElement | null;
}

/**
 * Lets you dismiss suggested TODOs from a list, with Undo. A dismissed one goes at once, before the list is read
 * again, and Undo puts it back even after the reloaded list has left it out.
 * @param items The suggestions, as last read.
 * @param refOf How a suggestion is known: its call, when it was said and its words.
 * @returns The suggestions to show, a dismiss action and the Undo bar.
 */
export function useDismissals<T>(items: T[], refOf: (item: T) => SuggestionRef): Dismissals<T> {
  /** Dismissed here, by key, so they stay hidden until the list is read again without them. */
  const [gone, setGone] = useState<Set<string>>(new Set());
  /** Brought back by Undo, shown until the list is read again with them. */
  const [restored, setRestored] = useState<T[]>([]);
  const [last, setLast] = useState<T | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * A suggestion's key.
   * @param item The suggestion.
   * @returns Its key.
   */
  const keyOf = (item: T) => suggestionKey(refOf(item));
  const shown = visibleSuggestions(items, restored, gone, keyOf);

  /**
   * Dismisses a suggestion, hiding it straight away; it comes back if saving fails.
   * @param item The suggestion.
   */
  const dismiss = async (item: T) => {
    const key = keyOf(item);
    setGone((current) => new Set(current).add(key));
    setLast(item);
    setProblem(null);
    try {
      await window.timeCenter.dismissSuggestion(refOf(item));
    } catch (error) {
      setGone((current) => without(current, key));
      // Only this one's Undo goes; one dismissed since keeps its own.
      setLast((current) => (current === item ? null : current));
      setProblem(`Couldn't dismiss it: ${readableError(error)}`);
    }
  };

  /** Brings back the suggestion just dismissed. */
  const undo = async () => {
    if (last === null) {
      return;
    }
    const key = keyOf(last);
    try {
      await window.timeCenter.restoreSuggestion(refOf(last));
      setGone((current) => without(current, key));
      setRestored((current) => [...current.filter((item) => keyOf(item) !== key), last]);
      setLast(null);
    } catch (error) {
      setProblem(`Couldn't bring it back: ${readableError(error)}`);
    }
  };

  const note =
    last === null && problem === null ? null : (
      <p className={problem ? "undo-note error" : "undo-note"} role="status">
        {problem ?? `Dismissed "${last === null ? "" : refOf(last).text}".`}
        {last !== null && !problem && (
          <button type="button" className="link" onClick={() => void undo()}>
            Undo
          </button>
        )}
        <button
          type="button"
          className="link"
          aria-label="Close"
          onClick={() => {
            setLast(null);
            setProblem(null);
          }}
        >
          ✕
        </button>
      </p>
    );

  return { shown, dismiss: (item) => void dismiss(item), anyDismissed: gone.size > 0, note };
}

/**
 * Works out which suggestions to show: the list as last read, plus ones Undo brought back that the list doesn't
 * have yet, less ones just dismissed. Each shows once.
 * @param items The suggestions, as last read.
 * @param restored Brought back by Undo.
 * @param gone Keys of the ones just dismissed.
 * @param keyOf A suggestion's key.
 * @returns The suggestions to show, the list's first, in its order.
 */
export function visibleSuggestions<T>(items: T[], restored: T[], gone: ReadonlySet<string>, keyOf: (item: T) => string): T[] {
  const listed = new Set(items.map(keyOf));
  return [...items, ...restored.filter((item) => !listed.has(keyOf(item)))].filter((item) => !gone.has(keyOf(item)));
}

/**
 * A suggestion's key, the same for the same call, moment and words.
 * @param ref The suggestion.
 * @returns The key.
 */
export function suggestionKey(ref: SuggestionRef): string {
  return `${ref.recordingId}:${ref.saidAt}:${ref.text}`;
}

/**
 * A copy of a set without one key.
 * @param set The set.
 * @param key The key to leave out.
 * @returns The copy.
 */
function without(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  next.delete(key);
  return next;
}
