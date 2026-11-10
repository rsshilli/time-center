import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { SAMPLE_RATE, readWav } from "./wavSamples";

/** macOS's audio converter. */
const AFCONVERT = "/usr/bin/afconvert";

/**
 * Decodes a call's mixed audio file (m4a) to 16 kHz mono samples with macOS's afconvert, through a temporary
 * WAV file that is deleted afterwards.
 * @param audioPath The m4a file.
 * @param tempDir A folder for the WAV.
 * @returns The samples.
 */
export async function decodeCallAudio(audioPath: string, tempDir: string): Promise<Float32Array> {
  await mkdir(tempDir, { recursive: true });
  const wav = join(tempDir, `call-${process.pid}-${Date.now()}.wav`);
  try {
    await promisify(execFile)(AFCONVERT, ["-f", "WAVE", "-d", `LEI16@${SAMPLE_RATE}`, "-c", "1", audioPath, wav]);
    return readWav(await readFile(wav)).samples;
  } finally {
    await rm(wav, { force: true });
  }
}
