import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import { SCREENSHOT_SCHEME } from "../../shared/ipc";
import type { ActivityStore } from "../activity/ActivityStore";

/**
 * Declares the screenshot URL scheme. Electron requires this before the app is ready.
 */
export function registerScreenshotScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCREENSHOT_SCHEME, privileges: { standard: true, secure: true } }]);
}

/**
 * Serves `time-center-shot://shot/<id>/thumb` and `/full` to the dashboard. Only files recorded in the
 * screenshots table can be read, so the renderer can't use it to open any other file on the Mac.
 * @param activity The screenshots table.
 */
export function handleScreenshotScheme(activity: Pick<ActivityStore, "getScreenshot">): void {
  protocol.handle(SCREENSHOT_SCHEME, async (request) => {
    const target = parseScreenshotUrl(request.url);
    const shot = target ? activity.getScreenshot(target.id) : null;
    const path = target?.size === "full" ? shot?.path : shot?.thumbPath;
    if (!path) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(path).toString());
  });
}

/**
 * Reads a screenshot URL made by screenshotUrl().
 * @param url e.g. "time-center-shot://shot/42/thumb".
 * @returns The screenshot id and size, or null for anything else.
 */
export function parseScreenshotUrl(url: string): { id: number; size: "thumb" | "full" } | null {
  const match = new RegExp(`^${SCREENSHOT_SCHEME}://shot/(\\d+)/(thumb|full)$`).exec(url);
  return match ? { id: Number(match[1]), size: match[2] as "thumb" | "full" } : null;
}
