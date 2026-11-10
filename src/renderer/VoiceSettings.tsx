import { useEffect, useState } from "react";
import type { NamedVoice } from "../shared/ipc";
import { readableError } from "./CalendarSettings";

/**
 * The people you've named in calls, whose voices are recognized in later ones: rename someone, or forget them
 * and their voiceprint (their calls go back to "Speaker N"). Voiceprints stay on this Mac and in the weekly
 * backup.
 */
export function VoiceSettings() {
  const [voices, setVoices] = useState<NamedVoice[] | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void window.timeCenter.getVoices().then(setVoices);
  }, []);

  if (!voices) {
    return null;
  }

  /**
   * Runs a change and shows the list it returns, or what went wrong.
   * @param change The change.
   */
  const apply = async (change: () => Promise<NamedVoice[]>) => {
    try {
      setVoices(await change());
      setRenaming(null);
      setMessage(null);
    } catch (error) {
      setMessage(readableError(error));
    }
  };

  /**
   * Forgets someone, after asking.
   * @param voice The person.
   */
  const forget = (voice: NamedVoice) => {
    if (window.confirm(`Forget ${voice.name} and their voiceprint? Their calls go back to "Speaker N".`)) {
      void apply(() => window.timeCenter.forgetVoice(voice.id));
    }
  };

  return (
    <section className="voice-settings">
      <h1>People's voices</h1>
      <p className="lead">
        Name a speaker in a call's transcript (click "Speaker 2") and their voice is recognized in later calls. A sure
        match shows their name; a likely one shows "Name?" for you to confirm.
      </p>
      <div className="settings">
        {voices.length === 0 ? (
          <p className="muted">No one named yet.</p>
        ) : (
          <ul className="voice-list">
            {voices.map((voice) => (
              <li key={voice.id}>
                {renaming?.id === voice.id ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void apply(() => window.timeCenter.renameVoice(voice.id, renaming.name));
                    }}
                  >
                    <input
                      autoFocus
                      value={renaming.name}
                      maxLength={80}
                      onChange={(event) => setRenaming({ id: voice.id, name: event.target.value })}
                    />
                    <button type="submit" disabled={renaming.name.trim() === ""}>
                      Save
                    </button>
                    <button type="button" className="link" onClick={() => setRenaming(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="voice-name">{voice.name}</span>
                    <span className="muted">{voice.calls === 1 ? "1 call" : `${voice.calls} calls`}</span>
                    <button
                      type="button"
                      className="link"
                      onClick={() => setRenaming({ id: voice.id, name: voice.name })}
                    >
                      Rename
                    </button>
                    <button type="button" className="link" onClick={() => forget(voice)}>
                      Forget
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {message && <p className="message">{message}</p>}
      </div>
    </section>
  );
}
