import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The one hand-drawn source: an orange square with a white rabbit whose head is a clock. */
const SOURCE = "resources/icon.svg";

/** macOS menu-bar icons are 18 points tall; the @2x copy is for Retina screens. */
const TRAY_SIZES = [
  { size: 18, file: "resources/tray.png" },
  { size: 36, file: "resources/tray@2x.png" },
];

/** The menu-bar icon while a call is being recorded: the same rabbit with a red dot in its corner. */
const RECORDING_TRAY_SIZES = [
  { size: 18, file: "resources/tray-recording.png" },
  { size: 36, file: "resources/tray-recording@2x.png" },
];

/** The red dot, in the source's 64-unit space, ringed in white so it reads on the orange. */
const RECORDING_DOT = '<circle cx="50" cy="14" r="12" fill="#E3242B" stroke="#FFFFFF" stroke-width="3"/>';

/** Every image an .icns file holds, named the way `iconutil` expects. */
const ICONSET = [
  { size: 16, name: "icon_16x16.png" },
  { size: 32, name: "icon_16x16@2x.png" },
  { size: 32, name: "icon_32x32.png" },
  { size: 64, name: "icon_32x32@2x.png" },
  { size: 128, name: "icon_128x128.png" },
  { size: 256, name: "icon_128x128@2x.png" },
  { size: 256, name: "icon_256x256.png" },
  { size: 512, name: "icon_256x256@2x.png" },
  { size: 512, name: "icon_512x512.png" },
  { size: 1024, name: "icon_512x512@2x.png" },
];

/**
 * Renders the menu-bar PNGs and the app icon (build/icon.icns, which electron-builder picks up) from
 * resources/icon.svg. Run `npm run icons` after editing the SVG; needs `rsvg-convert` (Homebrew librsvg).
 */
function main(): void {
  const source = readFileSync(SOURCE, "utf8");
  for (const { size, file } of TRAY_SIZES) {
    renderPng(source, size, file);
  }
  const recording = source.replace(/<\/svg>\s*$/, `${RECORDING_DOT}</svg>`);
  for (const { size, file } of RECORDING_TRAY_SIZES) {
    renderPng(recording, size, file);
  }
  buildAppIcon(padForAppIcon(source), "build/icon.icns");
}

/**
 * Draws an SVG at a square pixel size.
 * @param svg The SVG text.
 * @param size Width and height in pixels.
 * @param outFile Where to write the PNG.
 */
function renderPng(svg: string, size: number, outFile: string): void {
  execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), "-o", outFile], { input: svg });
}

/**
 * Shrinks the artwork onto Apple's app-icon grid: an 824-pixel square centred on a 1024 canvas, so the
 * icon sits the same size as other apps' icons in Finder and in permission prompts.
 * @param svg The full-bleed source SVG.
 * @returns A 1024-unit SVG with the source nested inside its margin.
 */
function padForAppIcon(svg: string): string {
  const nested = svg.replace("<svg ", '<svg x="100" y="100" width="824" height="824" ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${nested}</svg>`;
}

/**
 * Renders every iconset size and packs them into an .icns file.
 * @param svg The padded app-icon SVG.
 * @param outFile Where to write the .icns.
 */
function buildAppIcon(svg: string, outFile: string): void {
  const workDir = mkdtempSync(join(tmpdir(), "time-center-icon-"));
  try {
    const iconset = join(workDir, "icon.iconset");
    execFileSync("mkdir", [iconset]);
    for (const { size, name } of ICONSET) {
      renderPng(svg, size, join(iconset, name));
    }
    execFileSync("mkdir", ["-p", "build"]);
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", outFile]);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main();
