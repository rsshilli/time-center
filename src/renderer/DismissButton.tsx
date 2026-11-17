/**
 * The ✕ beside a suggested TODO that dismisses it: not something to do, so it isn't shown or suggested again.
 * @param props.onClick Dismisses it.
 */
export function DismissButton({ onClick }: { onClick(): void }) {
  return (
    <button type="button" className="link action-dismiss" title="Dismiss: not a TODO" aria-label="Dismiss: not a TODO" onClick={onClick}>
      ✕
    </button>
  );
}
