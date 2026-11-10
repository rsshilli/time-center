import { ipcMain } from "electron";
import { IPC, type CallSpeaker, type NamedVoice } from "../../shared/ipc";
import type { Attendee } from "../calendar/meetingLinks";
import { assertRowId } from "../ipcHandlers";
import { SURE_NEEDS_LINES, VOICE_SURE } from "./speakerMath";
import type { SpeakerService } from "./SpeakerService";
import type { SpeakerStore, StoredSpeaker } from "./SpeakerStore";

/** What the speaker requests are answered from. */
export interface SpeakerIpcDependencies {
  service: Pick<SpeakerService, "nameSpeaker" | "renameVoice" | "forgetVoice">;
  store: Pick<SpeakerStore, "listVoices" | "countCallsByVoice">;
}

/**
 * Answers naming a call's speakers, and Settings' list of the people you've named.
 * @param deps The speaker service and store.
 */
export function registerSpeakerIpc(deps: SpeakerIpcDependencies): void {
  ipcMain.handle(IPC.nameSpeaker, (_event, speakerId: unknown, name: unknown) => {
    if (name !== null && typeof name !== "string") {
      throw new Error("Not a name.");
    }
    deps.service.nameSpeaker(assertRowId(speakerId), name);
  });
  ipcMain.handle(IPC.getVoices, () => listNamedVoices(deps.store));
  ipcMain.handle(IPC.renameVoice, (_event, voiceId: unknown, name: unknown) => {
    if (typeof name !== "string") {
      throw new Error("Not a name.");
    }
    deps.service.renameVoice(assertRowId(voiceId), name);
    return listNamedVoices(deps.store);
  });
  ipcMain.handle(IPC.forgetVoice, (_event, voiceId: unknown) => {
    deps.service.forgetVoice(assertRowId(voiceId));
    return listNamedVoices(deps.store);
  });
}

/**
 * Everyone you've named, with how many calls they're in.
 * @param store The speakers table.
 * @returns Them, by name.
 */
export function listNamedVoices(store: Pick<SpeakerStore, "listVoices" | "countCallsByVoice">): NamedVoice[] {
  const calls = store.countCallsByVoice();
  return store.listVoices().map((voice) => ({ id: voice.id, name: voice.name, calls: calls.get(voice.id) ?? 0 }));
}

/**
 * One call's speakers as the screen and Claude see them.
 * @param store The speakers tables.
 * @param recordingId The call.
 * @returns Them, by number.
 */
export function callSpeakers(store: Pick<SpeakerStore, "listSpeakers" | "listVoices">, recordingId: number): CallSpeaker[] {
  return describeSpeakers(store.listSpeakers(recordingId), new Map(store.listVoices().map((voice) => [voice.id, voice.name])));
}

/**
 * A call's speakers as the screen shows them: by name when you named them or the match is sure, as a
 * question when it's a guess, else as "Speaker N" (name null).
 * @param speakers The call's speakers.
 * @param names Person id → name.
 * @returns Them, by number.
 */
export function describeSpeakers(speakers: StoredSpeaker[], names: Map<number, string>): CallSpeaker[] {
  return speakers.map((speaker) => {
    const name = speaker.voiceId === null ? null : (names.get(speaker.voiceId) ?? null);
    const sure = speaker.confirmed || ((speaker.voiceScore ?? 0) >= VOICE_SURE && speaker.weight >= SURE_NEEDS_LINES);
    return { id: speaker.id, number: speaker.number, name, sure: name !== null && sure };
  });
}

/**
 * The names offered when you name a speaker: the meeting's invitees first (as Google names them, or from
 * their email address), then everyone named before; each once.
 * @param invitees The meeting's invitees (not you), if the call matched a meeting.
 * @param named The people named so far.
 * @returns The names.
 */
export function nameChoices(invitees: readonly Attendee[], named: readonly string[]): string[] {
  const seen = new Set<string>();
  const choices: string[] = [];
  for (const name of [...invitees.map(inviteeName), ...named]) {
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      choices.push(name);
    }
  }
  return choices;
}

/**
 * An invitee's name: Google's, else made from the email ("dana.smith@x.com" → "Dana Smith").
 * @param invitee The invitee.
 * @returns The name.
 */
export function inviteeName(invitee: Attendee): string {
  if (invitee.name) {
    return invitee.name;
  }
  return invitee.email
    .split("@")[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}
