import { useState, type Ref, type UIEvent } from "react";
import type { CallRecording } from "../shared/ipc";
import { YOUR_VOICE, formatClock, groupTurns, isYou, speakerLabel, type Turn } from "../shared/transcript";
import { readableError } from "./CalendarSettings";

/** Fired on window after a speaker is named, so the calls are re-read at once rather than at the next poll. */
export const SPEAKERS_CHANGED = "time-center:speakers-changed";

/** Speaker colours, by number; your own lines keep the orange. */
const SPEAKER_COLOURS = ["#2f6fdf", "#1f9d6b", "#a646c9", "#d14b6a", "#b8860b", "#3a9fbf", "#7a5cff", "#5f7d1f"];

/**
 * A call's transcript, turn by turn. The other side's turns show who spoke ("Speaker 2", "Dana", or "Dana?"
 * when it's a guess); clicking that opens a box to name them, offering the meeting's invitees and everyone
 * named before. A line from your microphone that wasn't you can be hidden ("Not me"), with Undo.
 * @param props.recording The call.
 * @param props.listRef The list, for the live panel's scrolling.
 * @param props.onScroll Called when the list scrolls.
 */
export function TranscriptTurns({
  recording,
  listRef,
  onScroll,
}: {
  recording: CallRecording;
  listRef?: Ref<HTMLOListElement>;
  onScroll?(event: UIEvent<HTMLOListElement>): void;
}) {
  const turns = groupTurns(recording.lines, recording.speakers);
  /** The turn whose naming box is open, by its start time. */
  const [naming, setNaming] = useState<number | null>(null);
  /** The line just marked "not me", for Undo, and whether your voice is learned again without it. */
  const [hidden, setHidden] = useState<{ lineId: number; unlearned: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * Says whether a microphone line was you, and re-reads the calls.
   * @param lineId The line.
   * @param notYou True when it wasn't.
   */
  const markLine = async (lineId: number, notYou: boolean) => {
    try {
      const unlearned = await window.timeCenter.setLineNotYou(lineId, notYou);
      setProblem(null);
      setHidden(notYou ? { lineId, unlearned } : null);
      window.dispatchEvent(new Event(SPEAKERS_CHANGED));
    } catch (caught) {
      setProblem(readableError(caught));
    }
  };

  return (
    <>
      {(hidden !== null || problem) && (
        <p className={problem ? "undo-note error" : "undo-note"} role="status">
          {problem ??
            (hidden?.unlearned === false
              ? "Hid a line that wasn't you. This call's audio is gone, so what it taught the app about your voice stays."
              : "Hid a line that wasn't you; it no longer teaches the app your voice.")}
          {hidden !== null && !problem && (
            <button type="button" className="link" onClick={() => void markLine(hidden.lineId, false)}>
              Undo
            </button>
          )}
          <button type="button" className="link" aria-label="Close" onClick={() => {
            setHidden(null);
            setProblem(null);
          }}>
            ✕
          </button>
        </p>
      )}
      <TurnList
        recording={recording}
        turns={turns}
        naming={naming}
        setNaming={setNaming}
        onNotYou={(lineId) => void markLine(lineId, true)}
        listRef={listRef}
        onScroll={onScroll}
      />
    </>
  );
}

/**
 * The turns themselves. Your microphone's turns show each line on its own, with "Not me" on hover.
 * @param props.recording The call.
 * @param props.turns Its turns.
 * @param props.naming The turn whose naming box is open, by its start time.
 * @param props.setNaming Opens or closes a naming box.
 * @param props.onNotYou Marks a microphone line as not you.
 * @param props.listRef The list, for the live panel's scrolling.
 * @param props.onScroll Called when the list scrolls.
 */
function TurnList({
  recording,
  turns,
  naming,
  setNaming,
  onNotYou,
  listRef,
  onScroll,
}: {
  recording: CallRecording;
  turns: Turn[];
  naming: number | null;
  setNaming(start: number | null): void;
  onNotYou(lineId: number): void;
  listRef?: Ref<HTMLOListElement>;
  onScroll?(event: UIEvent<HTMLOListElement>): void;
}) {
  return (
    <ol className="transcript" ref={listRef} onScroll={onScroll}>
      {turns.map((turn, index) => {
        const speaker = recording.speakers.find((each) => each.id === turn.speakerId) ?? null;
        // Your own voice heard on their side keeps your colour.
        const colour =
          speaker && !(isYou(speaker) && speaker.sure)
            ? SPEAKER_COLOURS[(speaker.number - 1) % SPEAKER_COLOURS.length]
            : undefined;
        const label = speakerLabel(turn, recording.speakers);
        return (
          <li
            key={`${index}:${turn.side}@${turn.start}`}
            className={colour === undefined && speaker ? "turn turn-me" : `turn turn-${turn.side}`}
          >
            <span className="turn-time">{formatClock(turn.start)}</span>
            {speaker ? (
              <button
                type="button"
                className={
                  speaker.name !== null && !speaker.sure ? "turn-side speaker-tag guess" : "turn-side speaker-tag"
                }
                style={{ color: colour }}
                title={speaker.name === null ? "Who is this? Click to name them" : "Click to change who this is"}
                onClick={() => setNaming(naming === turn.start ? null : turn.start)}
              >
                {label}
              </button>
            ) : (
              <span className="turn-side" title={turn.side === "them" ? "This voice wasn't told apart" : undefined}>
                {label}
              </span>
            )}
            {turn.side === "me" ? (
              <span className="turn-text">
                {turn.lines.map((line, at) => (
                  <span key={line.id ?? `${line.start}:${at}`} className="mic-line">
                    {line.text}
                    {line.id !== undefined && (
                      <button
                        type="button"
                        className="not-me"
                        title="Someone else's voice, picked up by your microphone: hide it"
                        onClick={() => onNotYou(line.id!)}
                      >
                        Not me
                      </button>
                    )}{" "}
                  </span>
                ))}
              </span>
            ) : (
              <span className="turn-text">{turn.text}</span>
            )}
            {speaker && naming === turn.start && (
              <SpeakerNamer speaker={speaker} choices={recording.nameChoices} onDone={() => setNaming(null)} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The box for naming a speaker: type or pick a name, confirm a guess, or forget a name given before.
 * @param props.speaker The speaker.
 * @param props.choices Names to offer.
 * @param props.onDone Closes the box.
 */
function SpeakerNamer({
  speaker,
  choices,
  onDone,
}: {
  speaker: CallRecording["speakers"][number];
  choices: string[];
  onDone(): void;
}) {
  const [name, setName] = useState(speaker.name ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listId = `speaker-names-${speaker.id}`;

  /**
   * Saves who the speaker is (null: back to "Speaker N").
   * @param value The name.
   */
  const save = async (value: string | null) => {
    setBusy(true);
    try {
      await window.timeCenter.nameSpeaker(speaker.id, value);
      window.dispatchEvent(new Event(SPEAKERS_CHANGED));
      onDone();
    } catch (caught) {
      setProblem(readableError(caught));
      setBusy(false);
    }
  };

  return (
    <form
      className="speaker-namer"
      onSubmit={(event) => {
        event.preventDefault();
        void save(name);
      }}
    >
      <label>
        {`Speaker ${speaker.number} is`}
        <input
          autoFocus
          list={listId}
          value={name}
          placeholder="Their name"
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onDone();
            }
          }}
        />
      </label>
      <datalist id={listId}>
        {choices.map((choice) => (
          <option key={choice} value={choice} />
        ))}
      </datalist>
      <button type="submit" disabled={busy || name.trim() === ""}>
        {speaker.name !== null && !speaker.sure && name === speaker.name ? `Yes, it's ${speaker.name}` : "Save"}
      </button>
      {speaker.name !== null && (
        <button type="button" className="secondary" disabled={busy} onClick={() => void save(null)}>
          {`Not ${speaker.name}`}
        </button>
      )}
      <button type="button" className="link" onClick={onDone}>
        Cancel
      </button>
      <span className="speaker-choices">
        {/* On some calls the Mac's sound carried your own voice; naming it hides those repeated lines. */}
        <button
          type="button"
          className="chip"
          disabled={busy}
          title="It's my own voice, repeated"
          onClick={() => void save(YOUR_VOICE)}
        >
          That's me
        </button>
        {choices
          .filter((choice) => choice.toLowerCase() !== YOUR_VOICE.toLowerCase())
          .slice(0, 6)
          .map((choice) => (
            <button key={choice} type="button" className="chip" disabled={busy} onClick={() => void save(choice)}>
              {choice}
            </button>
          ))}
      </span>
      {problem && <p className="error">{problem}</p>}
    </form>
  );
}
