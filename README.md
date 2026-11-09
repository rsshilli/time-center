# Time Center

A Mac menu-bar app that shows where your day went. It joins your meetings on time, then records and
transcribes your calls.

Everything stays on your Mac: the activity log, screenshots, recordings and transcripts. Nothing leaves
it except two things, and only if you turn them on: a weekly backup of the database to your own S3
bucket, and meeting titles sent to Claude to sort them into types.

## What it does

- **Today tab.** A timeline of the day, with each stretch of time labelled by app, website or window and
  sorted into categories such as "Code review" or "Email". Click any stretch to see the screenshot taken
  then. To add time the Mac couldn't see, such as a call on your phone or a drive, drag across the timeline.
- **Joins meetings.** It reads your Google Calendar and opens each meeting 30 seconds before it starts.
  Zoom meetings open in the Zoom app; Google Meet and Teams open in Chrome, where you click Join.
- **Records calls.** Whenever another app is using the microphone (Zoom, Meet, Teams, Slack…), the call is
  recorded, and a red dot shows
  on the menu-bar icon. Each call becomes one file, such as `2026-11-09 Weekly sync.m4a`.
- **Transcribes calls on your Mac.** Transcription uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
  at low priority, and nothing is uploaded.
- **Recordings tab.** Your calls for the day, each with its transcript, a Copy button and a link to the
  audio file. Pick a day in either the Today tab or the Recordings tab, and the other tab shows the same day.
- **Settings.** Category rules (with a filter box to find one), apps to ignore, your calendar, meeting
  types and the weekly backup.

### Privacy defaults

- **Screenshots** are taken of every display once a minute, but only when the Mac isn't busy. They're
  deleted after 30 days and never backed up.
- **Recordings** have their audio deleted after 30 days. Transcripts are kept.
- **Microsoft Edge** is never tracked. While Edge is in front, time counts as "Untracked" and no title,
  web address or screenshot is kept. Use Edge for anything you don't want logged. You can add other apps
  under Settings → Ignored apps.

## Requirements

- An Apple Silicon Mac (M1 or later) running macOS 15 or newer.
- [Node.js](https://nodejs.org) 22 or newer.
- Xcode or the Command Line Tools (`xcode-select --install`), to build the two small Swift helpers.
- [Homebrew](https://brew.sh), for whisper.cpp: `brew install whisper-cpp`.
- Google Chrome, for Meet and Teams, and to read the address of the tab you're on.
- **Optional:** a Google Cloud OAuth client, for calendar joining (see below).
- **Optional:** AWS credentials, for backups to S3 and for sorting meetings into types with Claude on
  Amazon Bedrock.

## Install

```bash
git clone https://github.com/rsshilli/time-center.git
cd time-center
npm install
npm run signing:setup   # once: a local certificate so macOS remembers the app's permissions
npm run packageAndRun   # builds dist/mac-arm64/Time Center.app and opens it
```

The app has no Dock icon; look for it in the menu bar. To keep it, drag `dist/mac-arm64/Time Center.app`
into `/Applications`. It starts at login on its own.

`npm run signing:setup` matters. macOS ties permissions to the app's signature. Without a fixed
certificate, every rebuild would be a "new" app, and you'd have to grant every permission again. The
certificate is self-signed, trusted only by your Mac, and kept in its own keychain. If you have an Apple
Development certificate, signing uses that instead.

### Permissions

On first launch the **Permissions** tab lists what the app needs, each with a button to the right page of
System Settings:

| Permission | Why |
|------------|-----|
| Accessibility | Reads the title of the window in front |
| Screen Recording | Takes the once-a-minute screenshots and records the other side of a call |
| Microphone | Records your side of a call |
| Control Google Chrome | Reads the address of the Chrome tab you're on |

macOS only applies Screen Recording after the app restarts; the Permissions tab says so when that's needed.

### Speech model

The first call you record downloads Whisper's `large-v3-turbo` model (about 1.6 GB) into
`~/Library/Application Support/Time Center/models/`. Until whisper.cpp is installed, calls are still
recorded but not transcribed. The Recordings tab tells you how to install it.

## Optional setup

### Google Calendar (joining meetings)

The app signs in to Google with its own OAuth client, which is built into the app from a gitignored `.env`.

1. In [Google Cloud Console](https://console.cloud.google.com), create a project and enable the
   **Google Calendar API**.
2. Under **APIs & Services → Credentials**, create an **OAuth client ID** of type **Desktop app** and
   download its JSON file.
3. Run `npm run google:client -- ~/Downloads/client_secret_….json`. This writes the client's id and secret
   into `.env` and prints only the id.
4. Run `npm run packageAndRun` again, then go to **Settings → Meetings** and sign in.

The app asks only for read-only calendar access (`calendar.readonly`).

### Weekly backup to S3

Under **Settings → Weekly backup**, enter a bucket, its region and an AWS profile name from `~/.aws`. You
can also enter a KMS key. Once a week the app uploads a copy of the database, and it catches up after a
week the Mac was off. To move to a new Mac, use **Restore latest backup…** on the same page. Screenshots
and audio aren't included.

### Meeting types (Claude on Bedrock)

Under **Settings → Meeting types**, the app can ask Claude Haiku 4.5 on Amazon Bedrock to label each
meeting as a one-on-one, a daily stand-up, management, an architecture or product review, a customer call,
or other. It sends only the meeting's title and attendee
list. It uses the AWS keys your login shell exports (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and
`AWS_REGION`, which defaults to `us-east-1`). The account needs Bedrock access to Anthropic models.

## Where your data lives

All in `~/Library/Application Support/Time Center/`:

| Path | What |
|------|------|
| `time-center.db` | The SQLite database: activity, meetings, rules, transcripts |
| `screenshots/YYYY-MM-DD/` | Once-a-minute screenshots, kept 30 days |
| `recordings/` | One `.m4a` per call, kept 30 days |
| `models/` | The Whisper speech model |

To start over, quit the app and delete that folder.

## Developing

| Command | What it does |
|---------|--------------|
| `npm run dev` | Runs the app with hot reload |
| `npm test` | Runs the unit tests (vitest) |
| `npm run typecheck` | Type-checks everything |
| `npm run packageAndRun` | Builds, signs, quits the running copy and opens the new one |
| `npm run dist` | Also builds a `.dmg` |

A dev run started from a terminal borrows that terminal's macOS permissions, so the Permissions tab may
say everything is allowed when it isn't. Test permissions with the packaged app, opened by `packageAndRun`
or from Finder.

The code:

- `src/main/` is the Electron main process: activity tracking, calendar, recording, backup and the tray.
- `src/renderer/` is the React window.
- `native/` holds the Swift helpers: one reads the front window and takes screenshots, the other records calls.

## License

MIT. See [LICENSE](LICENSE).
