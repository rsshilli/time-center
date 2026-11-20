import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Errors on the page go to the app's log, so a screen that goes wrong while nobody's watching leaves a trace.
window.addEventListener("error", (event) => {
  void window.timeCenter.logProblem("error", `${event.message} at ${event.filename}:${event.lineno}`).catch(() => undefined);
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? (event.reason.stack ?? event.reason.message) : String(event.reason);
  void window.timeCenter.logProblem("error", `Unhandled: ${reason}`).catch(() => undefined);
});

createRoot(document.getElementById("root")!).render(<App />);
