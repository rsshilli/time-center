/**
 * Schema migrations, oldest first. The database's `PRAGMA user_version` records how many have run, so
 * only append to this list — never edit or reorder an entry that has shipped.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE backup_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    status      TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
    object_key  TEXT,
    bytes       INTEGER,
    error       TEXT
  );
  `,
  `
  -- One stretch of time with the same front window. kind: active (working in an app), idle (away from
  -- the keyboard), untracked (an ignored app such as Edge was in front; nothing else is stored).
  CREATE TABLE activity_segments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at   TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('active', 'idle', 'untracked')),
    app        TEXT,
    bundle_id  TEXT,
    title      TEXT,
    url        TEXT,
    domain     TEXT,
    project    TEXT
  );
  CREATE INDEX activity_segments_started_at ON activity_segments (started_at);
  CREATE INDEX activity_segments_ended_at ON activity_segments (ended_at);

  -- One row per display per minute screenshot, plus one row per minute skipped because the CPU was busy.
  CREATE TABLE screenshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    taken_at    TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('taken', 'skipped-busy')),
    display_id  TEXT,
    path        TEXT,
    thumb_path  TEXT,
    bytes       INTEGER,
    cpu_percent REAL,
    segment_id  INTEGER REFERENCES activity_segments (id) ON DELETE SET NULL
  );
  CREATE INDEX screenshots_taken_at ON screenshots (taken_at);
  `,
  `
  -- Meetings on the main Google calendar, refreshed every few minutes for the hours ahead. One row per
  -- occurrence: Google gives each occurrence of a repeating meeting its own id.
  CREATE TABLE calendar_events (
    event_id   TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    starts_at  TEXT NOT NULL,
    ends_at    TEXT NOT NULL,
    -- Your answer to the invitation: accepted, tentative, needsAction or declined.
    response   TEXT NOT NULL,
    -- meet, zoom or teams; null when the event has no meeting link.
    provider   TEXT,
    join_url   TEXT,
    synced_at  TEXT NOT NULL
  );
  CREATE INDEX calendar_events_starts_at ON calendar_events (starts_at);

  -- What happened at a meeting's join time. Keyed by the start too, so a moved meeting is decided afresh.
  CREATE TABLE meeting_joins (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id   TEXT NOT NULL,
    starts_at  TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('joined', 'skipped', 'failed')),
    decided_at TEXT NOT NULL,
    error      TEXT
  );
  CREATE UNIQUE INDEX meeting_joins_event ON meeting_joins (event_id, starts_at);
  `,
  `
  -- The link each decision was about, so a meeting that moves (or gets a new id) after you joined it
  -- isn't opened a second time.
  ALTER TABLE meeting_joins ADD COLUMN join_url TEXT;
  CREATE INDEX meeting_joins_url ON meeting_joins (join_url, decided_at);
  `,
  `
  -- Who else was invited (JSON list of {email, name}) and the repeating meeting each occurrence belongs to.
  ALTER TABLE calendar_events ADD COLUMN attendees TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE calendar_events ADD COLUMN series_id TEXT;
  UPDATE calendar_events SET series_id = event_id;

  -- Each meeting's type, kept per repeating series so every occurrence shares it. Kept apart from
  -- calendar_events, which each sync rewrites. source 'you' is a correction Haiku never overwrites.
  CREATE TABLE meeting_types (
    series_id  TEXT PRIMARY KEY,
    type       TEXT NOT NULL,
    source     TEXT NOT NULL CHECK (source IN ('haiku', 'you')),
    decided_at TEXT NOT NULL
  );
  `,
  `
  -- 1 when some app was using the microphone for the whole stretch (a call), so a meeting held in any app
  -- counts as attended. Stretches recorded before this read as 0.
  ALTER TABLE activity_segments ADD COLUMN on_call INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Stretches you marked on the timeline yourself ("On the phone", "Driving"), for time spent away from the
  -- Mac. They fill only the Away parts of the stretch. event_id: the calendar meeting it was, if any.
  CREATE TABLE manual_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at   TEXT NOT NULL,
    category   TEXT NOT NULL,
    event_id   TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX manual_entries_started_at ON manual_entries (started_at);
  `,
  `
  -- Calls recorded while some app used the microphone. folder holds me.m4a / them.m4a (kept 30 days, then
  -- deleted and audio_deleted_at set) and chunks/ waiting for whisper. ended_at is null while recording.
  CREATE TABLE recordings (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at       TEXT NOT NULL,
    ended_at         TEXT,
    folder           TEXT NOT NULL,
    mic              INTEGER NOT NULL DEFAULT 1,
    error            TEXT,
    audio_deleted_at TEXT
  );
  CREATE INDEX recordings_started_at ON recordings (started_at);

  -- What whisper heard, one line per spoken stretch. side: 'me' (your microphone) or 'them' (the Mac's sound).
  CREATE TABLE transcript_lines (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    recording_id INTEGER NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
    side         TEXT NOT NULL CHECK (side IN ('me', 'them')),
    started_at   TEXT NOT NULL,
    ended_at     TEXT NOT NULL,
    text         TEXT NOT NULL
  );
  CREATE INDEX transcript_lines_recording ON transcript_lines (recording_id, started_at);
  `,
  `
  -- The call's one audio file once both sides are mixed and it's named after the meeting
  -- ("2026-11-09 Yash & Ryan 1-1.m4a" in the recordings folder). Null until then; folder holds the working files.
  ALTER TABLE recordings ADD COLUMN audio_path TEXT;
  `,
  `
  -- Questions you asked Sonnet about your calls, and its answers. scope: 'call', 'day' or 'all'. sources is a
  -- JSON list of the calls sent ({recordingId, start, title}); note says how they were picked, when it matters.
  -- answer is null and error set when asking failed.
  CREATE TABLE recording_questions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    asked_at  TEXT NOT NULL,
    question  TEXT NOT NULL,
    scope     TEXT NOT NULL CHECK (scope IN ('call', 'day', 'all')),
    sources   TEXT NOT NULL,
    note      TEXT,
    answer    TEXT,
    error     TEXT
  );
  CREATE INDEX recording_questions_asked_at ON recording_questions (asked_at);
  `,
  `
  -- The action items Haiku found in a call while you watched it on the Recordings tab. items is a JSON list
  -- of { text, saidAt }; covered_until is the end of the last transcript line it had read.
  CREATE TABLE recording_action_items (
    recording_id  INTEGER PRIMARY KEY REFERENCES recordings (id) ON DELETE CASCADE,
    items         TEXT NOT NULL,
    covered_until TEXT NOT NULL,
    checked_at    TEXT NOT NULL
  );
  `,
  `
  -- How many transcript lines Haiku had read. Your side and theirs are transcribed separately, so a line can
  -- arrive with an earlier time than covered_until; the count notices it.
  ALTER TABLE recording_action_items ADD COLUMN covered_lines INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Your TODO list. markdown is the item as written; position orders the list (smallest first); done_at is set
  -- when it's ticked. An item added from a call's action items keeps the call (source_*) to link back to it.
  -- sent is a JSON list of where the item was sent ({ action, label, url, at }), e.g. a Jira ticket.
  CREATE TABLE todos (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    markdown            TEXT NOT NULL,
    position            REAL NOT NULL,
    created_at          TEXT NOT NULL,
    done_at             TEXT,
    source_recording_id INTEGER REFERENCES recordings (id) ON DELETE SET NULL,
    source_title        TEXT,
    source_said_at      TEXT,
    sent                TEXT NOT NULL DEFAULT '[]'
  );
  `,
];
