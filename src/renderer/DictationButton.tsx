import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { readableError } from "./CalendarSettings";
import { DICTATION_SAMPLE_RATE, encodeWav } from "./wav";

/** Held at least this long, the button is push-to-talk: letting go stops. A shorter press toggles. */
const HOLD_MS = 400;

/** Dictation stops on its own after this long. */
const MAX_DICTATION_MS = 120_000;

/** Less speech than this is taken for a slip of the finger. */
const MIN_DICTATION_MS = 300;

/** Samples per block the capture node hands over. */
const BLOCK_SIZE = 4096;

/** Where the button is up to. */
type DictationState = "idle" | "starting" | "listening" | "transcribing";

/** An open microphone capture. */
interface Capture {
  stream: MediaStream;
  context: AudioContext;
  chunks: Float32Array[];
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The mic button: click to talk and click again to stop, or hold it while you talk. The speech is turned into
 * text by whisper on the Mac and handed to `onText`.
 * @param props.onText Called with the words heard.
 * @param props.onError Called with a problem to show, or null to clear one.
 * @param props.disabled Whether the button can be used.
 */
export function DictationButton({
  onText,
  onError,
  disabled,
}: {
  onText: (text: string) => void;
  onError: (message: string | null) => void;
  disabled: boolean;
}) {
  const [state, setState] = useState<DictationState>("idle");
  const stateRef = useRef<DictationState>("idle");
  const capture = useRef<Capture | null>(null);
  /** Counts presses that open the microphone, so a slow open that was cancelled can tell it's stale. */
  const generation = useRef(0);
  const mounted = useRef(true);
  const pressedAt = useRef(0);
  /** Set when a press lands while listening, so its release stops (the second click of click-to-talk). */
  const stopOnRelease = useRef(false);

  /** Moves to a new state, keeping the ref the pointer handlers read in step. */
  const moveTo = (next: DictationState) => {
    stateRef.current = next;
    if (mounted.current) {
      setState(next);
    }
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      // Leaving the tab: let go of the microphone, and make a slow open still in progress stale.
      mounted.current = false;
      generation.current++;
      closeCapture(capture.current);
      capture.current = null;
    };
  }, []);

  /** Opens the microphone and starts collecting samples at whisper's rate. */
  const start = async () => {
    const mine = ++generation.current;
    moveTo("starting");
    onError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const context = new AudioContext({ sampleRate: DICTATION_SAMPLE_RATE });
      const source = context.createMediaStreamSource(stream);
      // ScriptProcessor is deprecated but needs no separate worklet file, and a question is short.
      const node = context.createScriptProcessor(BLOCK_SIZE, 1, 1);
      const chunks: Float32Array[] = [];
      node.onaudioprocess = (event) => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      source.connect(node);
      node.connect(context.destination);
      const opened: Capture = { stream, context, chunks, timer: setTimeout(() => void stop(mine), MAX_DICTATION_MS) };
      if (mine !== generation.current || stateRef.current !== "starting") {
        // Cancelled, pressed again or unmounted while the microphone was opening.
        closeCapture(opened);
        return;
      }
      capture.current = opened;
      moveTo("listening");
    } catch (caught) {
      if (mine === generation.current) {
        moveTo("idle");
        onError(`Couldn't use the microphone: ${readableError(caught)}. Check Microphone in the Permissions tab.`);
      }
    }
  };

  /**
   * Closes the microphone and has whisper turn what it heard into text.
   * @param which The press it belongs to; the two-minute limit passes its own, so it never stops a later one.
   */
  const stop = async (which = generation.current) => {
    const open = capture.current;
    if (!open || which !== generation.current) {
      return;
    }
    capture.current = null;
    closeCapture(open);
    const samples = open.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if ((samples / DICTATION_SAMPLE_RATE) * 1000 < MIN_DICTATION_MS) {
      moveTo("idle");
      return;
    }
    moveTo("transcribing");
    try {
      const text = await window.timeCenter.transcribeDictation(encodeWav(open.chunks, DICTATION_SAMPLE_RATE));
      if (!mounted.current) {
        return;
      }
      if (text === "") {
        onError("Didn't catch any words. Try again a little closer to the mic.");
      } else {
        onText(text);
      }
    } catch (caught) {
      if (mounted.current) {
        onError(`Couldn't turn that into text: ${readableError(caught)}`);
      }
    } finally {
      moveTo("idle");
    }
  };

  /**
   * A press starts listening, or marks the release to stop when already listening. The pointer is captured
   * so letting go off the button still counts as letting go.
   * @param event The press.
   */
  const press = (event: PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    if (stateRef.current === "idle") {
      pressedAt.current = Date.now();
      stopOnRelease.current = false;
      void start();
    } else if (stateRef.current === "listening") {
      stopOnRelease.current = true;
    }
  };

  /** A release after a long hold, or the second click, stops; letting go while the mic is opening cancels. */
  const release = () => {
    const held = Date.now() - pressedAt.current >= HOLD_MS;
    if (!(stopOnRelease.current || held)) {
      return;
    }
    if (stateRef.current === "starting") {
      generation.current++;
      moveTo("idle");
    } else if (stateRef.current === "listening") {
      void stop();
    }
  };

  /**
   * Space or Enter toggles, for the keyboard.
   * @param event The key.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key !== " " && event.key !== "Enter") || event.repeat) {
      return;
    }
    event.preventDefault();
    if (stateRef.current === "idle") {
      void start();
    } else if (stateRef.current === "listening") {
      void stop();
    }
  };

  const label =
    state === "listening" ? "Listening… click to stop" : state === "transcribing" ? "Turning speech into text…" : "Dictate a question";
  return (
    <button
      type="button"
      className={`mic-button ${state}`}
      aria-label={label}
      title={state === "idle" ? "Click to talk, click again to stop — or hold while you talk" : label}
      disabled={(disabled && state === "idle") || state === "transcribing"}
      onPointerDown={press}
      onPointerUp={release}
      onPointerCancel={release}
      onKeyDown={onKeyDown}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"
        />
      </svg>
    </button>
  );
}

/**
 * Lets go of the microphone and the audio graph.
 * @param open The capture, or null.
 */
function closeCapture(open: Capture | null): void {
  if (!open) {
    return;
  }
  clearTimeout(open.timer);
  for (const track of open.stream.getTracks()) {
    track.stop();
  }
  void open.context.close();
}
