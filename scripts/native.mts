import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

/**
 * The Swift helpers and where each compiled one goes; electron-builder copies resources/bin into the app's
 * Resources. The front-window reader needs macOS 14 (ScreenCaptureKit's one-shot screenshot, `--capture`);
 * the call recorder needs macOS 15 (the microphone on a ScreenCaptureKit stream).
 */
const HELPERS = [
  { source: "native/ActiveWindow.swift", output: "resources/bin/active-window", target: "arm64-apple-macos14" },
  { source: "native/MeetingRecorder.swift", output: "resources/bin/meeting-recorder", target: "arm64-apple-macos15" },
];

/**
 * Compiles the Swift helpers with `swiftc` (Xcode or the Command Line Tools). Run by `npm run native`, and by
 * `npm run dev` / `npm run package` before they start.
 */
function main(): void {
  mkdirSync("resources/bin", { recursive: true });
  for (const helper of HELPERS) {
    execFileSync("swiftc", ["-O", "-target", helper.target, helper.source, "-o", helper.output], { stdio: "inherit" });
    console.log(`Built ${helper.output}`);
  }
}

main();
