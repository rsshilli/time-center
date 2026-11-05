import type { TimeCenterApi } from "../shared/ipc";

declare global {
  /** The preload bridge, see src/preload/index.ts. */
  interface Window {
    timeCenter: TimeCenterApi;
  }
}
