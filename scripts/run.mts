import { execFileSync } from "node:child_process";

/** The packaged, signed app that `npm run package` builds. */
const APP = "dist/mac-arm64/Time Center.app";

/** The main process's name, as `pgrep` sees it (helper processes are "Time Center Helper …"). */
const PROCESS = "Time Center";

/** How long to wait for the old copy to finish quitting (it may be mid-backup). */
const QUIT_TIMEOUT_MS = 30_000;

/**
 * Quits any running copy of the packaged app, then launches the fresh build with `open`. Run by
 * `npm run packageAndRun` after packaging. `open` makes macOS treat it as Time Center itself, with its
 * own permissions; running the binary from a terminal would borrow the terminal's permissions instead.
 * Extra arguments are passed to the app, e.g. `npm run packageAndRun -- --open=permissions`.
 */
async function main(): Promise<void> {
  await quitRunningCopy();
  const appArgs = process.argv.slice(2);
  const openArgs = appArgs.length > 0 ? [APP, "--args", ...appArgs] : [APP];
  execFileSync("open", openArgs, { stdio: "inherit" });
  console.log(`Launched ${APP}`);
}

/**
 * Asks a running Time Center to quit and waits until it has gone, so `open` starts the new build
 * instead of bringing the old one to the front.
 */
async function quitRunningCopy(): Promise<void> {
  if (!isRunning()) {
    return;
  }
  console.log("Quitting the running Time Center…");
  execFileSync("osascript", ["-e", `quit app "${PROCESS}"`], { stdio: "inherit" });
  const deadline = Date.now() + QUIT_TIMEOUT_MS;
  while (isRunning()) {
    if (Date.now() > deadline) {
      throw new Error(`Time Center did not quit within ${QUIT_TIMEOUT_MS / 1000} s; quit it from the menu bar and try again.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Reports whether the packaged app's main process is running. `pgrep` exits 1 when nothing matches.
 */
function isRunning(): boolean {
  try {
    execFileSync("pgrep", ["-x", PROCESS], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
