import { useCallback, useEffect, useState } from "react";
import { screenshotUrl } from "../shared/ipc";

/**
 * A screenshot shown full size over the dashboard. "Copy" (or ⌘C) puts the original, full-resolution
 * file on the clipboard, not the scaled-down image on screen. Clicking outside the image or pressing
 * Escape closes it.
 * @param props.id The screenshot's id.
 * @param props.onClose Called to close it.
 */
export function ShotLightbox({ id, onClose }: { id: number; onClose: () => void }) {
  const [message, setMessage] = useState<string | null>(null);

  /** Copies the full-size screenshot and says whether it worked. */
  const copy = useCallback(() => {
    window.timeCenter
      .copyScreenshot(id)
      .then(() => setMessage("Copied at full size"))
      .catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        setMessage(`Couldn't copy it: ${text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`);
      });
  }, [id]);

  useEffect(() => {
    setMessage(null);
  }, [id]);

  useEffect(() => {
    /**
     * Copies on ⌘C and closes on Escape.
     * @param event The key press.
     */
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      } else if (event.metaKey && event.key.toLowerCase() === "c" && !window.getSelection()?.toString()) {
        event.preventDefault();
        copy();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [copy, onClose]);

  return (
    <div className="lightbox" onClick={onClose} role="presentation">
      <img src={screenshotUrl(id, "full")} alt="Full-size screenshot" />
      <div className="lightbox-actions" onClick={(event) => event.stopPropagation()} role="presentation">
        <button onClick={copy}>Copy</button>
        <span>{message ?? "⌘C copies it at full size · Esc closes"}</span>
      </div>
    </div>
  );
}
