import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

/** The Swift source of the front-window reader. */
const SOURCE = "native/ActiveWindow.swift";

/** Where the compiled helper goes; electron-builder copies resources/bin into the app's Resources. */
const OUTPUT = "resources/bin/active-window";

/**
 * Compiles the front-window helper with `swiftc` (Xcode or the Command Line Tools). Run by
 * `npm run native`, and by `npm run dev` / `npm run package` before they start.
 */
function main(): void {
  mkdirSync("resources/bin", { recursive: true });
  // macOS 14 is the first with ScreenCaptureKit's one-shot screenshot call, used by `--capture`.
  execFileSync("swiftc", ["-O", "-target", "arm64-apple-macos14", SOURCE, "-o", OUTPUT], { stdio: "inherit" });
  console.log(`Built ${OUTPUT}`);
}

main();
