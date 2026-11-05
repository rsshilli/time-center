/**
 * Spike: can Electron capture the Mac's system audio (the other side of a meeting) on this macOS?
 *
 * Run: `npm run spike:audio:electron -- --feature=<name>` where name is "none" (the default),
 * "MacLoopbackAudioForScreenShare" (ScreenCaptureKit) or "MacCatapLoopbackAudioForScreenShare" (Core
 * Audio process tap). It also writes the tone file that `npm run spike:audio:tap` plays.
 *
 * It opens a hidden window, asks for display media with `audio: "loopback"`, measures the captured level
 * for 1.5 s of quiet, then plays a quiet 440 Hz tone with `afplay` and measures again. A clear rise in
 * level during the tone means system audio is being captured. Prints one `SPIKE_RESULT {json}` line.
 */
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, desktopCapturer, ipcMain, session } from "electron";

const feature = process.argv.find((arg) => arg.startsWith("--feature="))?.slice("--feature=".length) ?? "none";
if (feature !== "none") {
  app.commandLine.appendSwitch("enable-features", feature);
}
// Without a click, Chromium keeps an AudioContext suspended and the analyser reads pure zeros.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

void main();

/**
 * Runs the spike once and quits, printing the result.
 */
async function main(): Promise<void> {
  await app.whenReady();
  app.dock?.hide();
  const tonePath = writeToneWav();
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      void desktopCapturer.getSources({ types: ["screen"] }).then((sources) => {
        callback({ video: sources[0], audio: "loopback" });
      });
    },
    { useSystemPicker: false },
  );

  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  const result = new Promise<unknown>((resolve) => ipcMain.once("spike-result", (_event, payload) => resolve(payload)));
  let toneExit: string = "not played";
  ipcMain.once("spike-play-tone", () => {
    execFile("afplay", ["-v", "0.2", tonePath], (error) => {
      toneExit = error ? `failed: ${error.message}` : "played";
    });
  });
  // A file:// page counts as a secure context; a data: URL does not, and then navigator.mediaDevices is undefined.
  const pagePath = join(tmpdir(), "time-center-spike.html");
  writeFileSync(pagePath, `<!doctype html><script>${rendererScript()}</script>`);
  await window.loadFile(pagePath);

  const timeout = new Promise((resolve) => setTimeout(() => resolve({ error: "timed out after 20 s" }), 20_000));
  const payload = await Promise.race([result, timeout]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log(`SPIKE_RESULT ${JSON.stringify({ feature, electron: process.versions.electron, toneExit, ...(payload as object) })}`);
  app.quit();
}

/**
 * Writes a 2-second 440 Hz sine tone as a 16-bit mono WAV file.
 * @returns The file's path.
 */
function writeToneWav(): string {
  const sampleRate = 44_100;
  const samples = sampleRate * 2;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.8 * 32767), 44 + i * 2);
  }
  const path = join(tmpdir(), "time-center-spike-tone.wav");
  writeFileSync(path, buffer);
  return path;
}

/**
 * The renderer side, as source text: capture display media, then measure RMS level before and during the tone.
 * @returns JavaScript to run in the hidden window.
 */
function rendererScript(): string {
  return `
const { ipcRenderer } = require("electron");
(async () => {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      // Echo cancellation treats system audio as the far end and removes it, so all processing is off.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const audioTracks = stream.getAudioTracks();
    const events = [];
    const started = performance.now();
    for (const track of stream.getTracks()) {
      track.addEventListener("ended", () => events.push(track.kind + " ended at " + Math.round(performance.now() - started) + " ms"));
    }
    const initialStates = stream.getTracks().map((t) => t.kind + ":" + t.readyState);
    if (audioTracks.length === 0) {
      ipcRenderer.send("spike-result", { audioTracks: 0, error: "no audio track in the display stream" });
      return;
    }
    const context = new AudioContext();
    await context.resume();
    // Control: prove the meter itself reads a signal, using a tone generated inside the page.
    const controlAnalyser = context.createAnalyser();
    const oscillator = context.createOscillator();
    oscillator.connect(controlAnalyser);
    oscillator.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const controlData = new Float32Array(controlAnalyser.fftSize);
    controlAnalyser.getFloatTimeDomainData(controlData);
    const controlRms = Math.sqrt(controlData.reduce((sum, v) => sum + v * v, 0) / controlData.length);
    oscillator.stop();

    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    const silent = context.createGain();
    silent.gain.value = 0;
    context.createMediaStreamSource(new MediaStream(audioTracks)).connect(analyser);
    analyser.connect(silent).connect(context.destination);
    const data = new Float32Array(analyser.fftSize);
    /** Samples the captured level every 50 ms for a while and resolves with the peak RMS. */
    const measure = (ms) => new Promise((resolve) => {
      let peak = 0;
      const end = performance.now() + ms;
      /** Reads one window of samples, then schedules the next until the time is up. */
      const tick = () => {
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (const v of data) { sum += v * v; }
        peak = Math.max(peak, Math.sqrt(sum / data.length));
        if (performance.now() < end) { setTimeout(tick, 50); } else { resolve(peak); }
      };
      tick();
    });
    const quietRms = await measure(1500);
    ipcRenderer.send("spike-play-tone");
    const toneRms = await measure(2000);
    ipcRenderer.send("spike-result", {
      audioTracks: audioTracks.length,
      trackLabel: audioTracks[0].label,
      trackSettings: audioTracks[0].getSettings(),
      contextState: context.state,
      controlRms,
      trackMuted: audioTracks[0].muted,
      trackReadyState: audioTracks[0].readyState,
      initialStates,
      finalStates: stream.getTracks().map((t) => t.kind + ":" + t.readyState),
      events,
      quietRms,
      toneRms,
      captured: toneRms > Math.max(0.005, quietRms * 4),
    });
  } catch (error) {
    ipcRenderer.send("spike-result", { error: String(error && error.message || error) });
  }
})();
`;
}
