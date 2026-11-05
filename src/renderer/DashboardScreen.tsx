import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { screenshotUrl, type DayReport, type ScreenshotInfo, type TimelineItem, type Total } from "../shared/ipc";
import { colourFor, formatClock, formatDay, formatDuration } from "./format";

/** While showing today, the dashboard re-reads the day this often. */
const REFRESH_MS = 30_000;

/** A screenshot counts as "at" the picked moment if it was taken within this long of it. */
const SHOT_MATCH_MS = 90_000;

/** How many rows each totals card lists. */
const TOP_N = 8;

/** One hour, in milliseconds: the timeline's grid. */
const HOUR = 3_600_000;

/** How many thumbnails the strip under the timeline shows, one per equal slice of the visible hours. */
const STRIP_SLOTS = 10;

/**
 * One day of your time: how long you worked, were away, or were in an ignored app; a timeline coloured
 * by category that you click to see that minute's screenshots and window; and totals by category, app,
 * project and website.
 */
export function DashboardScreen() {
  const [at, setAt] = useState(() => Date.now());
  const [report, setReport] = useState<DayReport | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Counts requests, so a slow answer for a day you already left can't replace a newer one. */
  const latestRequest = useRef(0);
  const today = startOfDay(Date.now());
  const isToday = report?.dayStart === today;

  /** Reads the day from the main process. */
  const load = useCallback(async () => {
    const request = ++latestRequest.current;
    try {
      const day = await window.timeCenter.getDay(at);
      if (request === latestRequest.current) {
        setReport(day);
        setError(null);
      }
    } catch (caught) {
      if (request === latestRequest.current) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }
  }, [at]);

  useEffect(() => {
    void load();
    if (startOfDay(at) !== startOfDay(Date.now())) {
      return undefined;
    }
    const timer = setInterval(() => {
      // Left open past midnight, "today" moves on to the new day rather than re-reading yesterday.
      if (startOfDay(at) !== startOfDay(Date.now())) {
        setAt(Date.now());
        setSelected(null);
        return;
      }
      void load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [at, load]);

  /**
   * Moves to the day before or after.
   * @param direction -1 for the day before, 1 for the day after.
   */
  const changeDay = (direction: -1 | 1) => {
    if (!report) {
      return;
    }
    setAt(direction === -1 ? report.dayStart - HOUR : report.dayEnd + HOUR);
    setSelected(null);
  };

  if (!report) {
    return error ? <p className="error">Couldn't load the day: {error}</p> : null;
  }
  const empty = report.timeline.length === 0;

  return (
    <section className="dashboard">
      <header className="day-header">
        <button className="secondary" onClick={() => changeDay(-1)} aria-label="Day before">
          ‹
        </button>
        <h1>{formatDay(report.dayStart, today)}</h1>
        <button className="secondary" onClick={() => changeDay(1)} disabled={isToday} aria-label="Day after">
          ›
        </button>
        {!isToday && (
          <button
            className="secondary"
            onClick={() => {
              setAt(Date.now());
              setSelected(null);
            }}
          >
            Today
          </button>
        )}
      </header>

      <div className="summary">
        <Stat label="Working" ms={report.activeMs} />
        <Stat label="Away" ms={report.idleMs} />
        <Stat label="Untracked (ignored apps)" ms={report.untrackedMs} />
      </div>

      {empty ? (
        <p className="lead">
          {isToday
            ? "Nothing recorded yet today. Time Center notes the window in front every few seconds, so this fills in as you work."
            : "Nothing was recorded on this day."}
        </p>
      ) : (
        <>
          <Timeline report={report} selected={selected} onSelect={setSelected} />
          <MomentPanel report={report} selected={selected ?? latestShot(report.screenshots) ?? null} />
          <div className="totals">
            <TotalsCard title="Categories" totals={report.byCategory} coloured />
            <TotalsCard title="Apps" totals={report.byApp} />
            <TotalsCard title="Projects" totals={report.byProject} empty="No WebStorm projects" />
            <TotalsCard title="Websites" totals={report.byDomain} empty="No Chrome tabs" />
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Finds local midnight for a moment.
 * @param ms The moment.
 * @returns Midnight, in milliseconds.
 */
function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * One headline number.
 * @param props.label What it counts.
 * @param props.ms How long.
 */
function Stat({ label, ms }: { label: string; ms: number }) {
  return (
    <div className="stat">
      <span className="stat-value">{formatDuration(ms)}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

/**
 * The day as a coloured bar, from the first hour with activity to the last, with a tick under it for
 * every minute that has a screenshot and a strip of thumbnails below. Clicking picks a moment.
 * @param props.report The day.
 * @param props.selected The picked moment, if any.
 * @param props.onSelect Called with the moment clicked.
 */
function Timeline({
  report,
  selected,
  onSelect,
}: {
  report: DayReport;
  selected: number | null;
  onSelect: (moment: number) => void;
}) {
  const { from, to } = visibleRange(report);
  const span = to - from;
  /**
   * Places a moment along the bar.
   * @param ms The moment.
   * @returns Its distance from the left edge, as a CSS percentage.
   */
  const percent = (ms: number) => `${((ms - from) / span) * 100}%`;
  const hours = useMemo(() => {
    const marks: number[] = [];
    for (let hour = from; hour <= to; hour += HOUR) {
      marks.push(hour);
    }
    return marks;
  }, [from, to]);
  const shotMinutes = useMemo(
    () => [...new Set(report.screenshots.filter((shot) => shot.status === "taken").map((shot) => shot.takenAt))],
    [report.screenshots],
  );

  /**
   * Turns a click on the bar into a moment.
   * @param event The click.
   */
  const pick = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    onSelect(from + ((event.clientX - box.left) / box.width) * span);
  };

  return (
    <div className="timeline">
      <div className="timeline-bar" onClick={pick} role="presentation">
        {report.timeline.map((item, index) => (
          <div
            key={index}
            className={`timeline-item ${item.kind}`}
            style={{
              left: percent(item.start),
              width: percent(from + (item.end - item.start)),
              background: colourFor(item.category),
            }}
            title={describeItem(item)}
          />
        ))}
        {selected !== null && <div className="timeline-cursor" style={{ left: percent(selected) }} />}
      </div>
      <div className="timeline-shots">
        {shotMinutes.map((minute) => (
          <span key={minute} style={{ left: percent(minute) }} />
        ))}
      </div>
      <div className="timeline-hours">
        {hours.map((hour) => (
          <span key={hour} style={{ left: percent(hour) }}>
            {new Date(hour).toLocaleTimeString(undefined, { hour: "numeric" })}
          </span>
        ))}
      </div>
      <ThumbStrip shots={report.screenshots} from={from} to={to} selected={selected} onSelect={onSelect} />
    </div>
  );
}

/**
 * What was going on at the picked moment: the window in front and that minute's screenshots.
 * @param props.report The day.
 * @param props.selected The moment, or null when nothing is picked and there are no screenshots.
 */
function MomentPanel({ report, selected }: { report: DayReport; selected: number | null }) {
  const [zoomed, setZoomed] = useState<number | null>(null);
  if (selected === null) {
    return <p className="hint">Click the timeline to see what you were doing at that moment.</p>;
  }
  const item = report.timeline.find((candidate) => candidate.start <= selected && selected < candidate.end);
  const shots = shotsNear(report.screenshots, selected);
  return (
    <div className="moment">
      <div className="moment-text">
        <strong>{formatClock(selected)}</strong>
        {item ? (
          <>
            <span className="moment-category" style={{ color: colourFor(item.category) }}>
              {item.category}
            </span>
            <span>{item.kind === "active" ? [item.app, item.title].filter(Boolean).join(" — ") : ""}</span>
            {item.url && <span className="muted">{item.url}</span>}
          </>
        ) : (
          <span className="muted">Nothing recorded at this moment.</span>
        )}
      </div>
      {shots.length > 0 ? (
        <div className="moment-shots">
          {shots.map((shot) => (
            <button key={shot.id} className="shot" onClick={() => setZoomed(shot.id)} title="Show full size">
              <img src={screenshotUrl(shot.id, "thumb")} alt={`Screenshot at ${formatClock(shot.takenAt)}`} />
            </button>
          ))}
        </div>
      ) : (
        <p className="muted">No screenshot within a minute and a half of this moment.</p>
      )}
      {zoomed !== null && (
        <div className="lightbox" onClick={() => setZoomed(null)} role="presentation">
          <img src={screenshotUrl(zoomed, "full")} alt="Full-size screenshot" />
        </div>
      )}
    </div>
  );
}

/**
 * Finds the newest screenshot's time, the moment shown before anything is clicked.
 * @param shots The day's screenshots.
 * @returns Its time, or undefined when there are none.
 */
function latestShot(shots: ScreenshotInfo[]): number | undefined {
  const taken = shots.filter((shot) => shot.status === "taken");
  return taken.length > 0 ? taken[taken.length - 1].takenAt : undefined;
}

/**
 * A ranked list of totals with proportional bars.
 * @param props.title The card heading.
 * @param props.totals The totals, largest first.
 * @param props.coloured Colour bars by category.
 * @param props.empty What to say when there are none.
 */
function TotalsCard({
  title,
  totals,
  coloured = false,
  empty = "Nothing yet",
}: {
  title: string;
  totals: Total[];
  coloured?: boolean;
  empty?: string;
}) {
  const largest = totals[0]?.ms ?? 1;
  return (
    <div className="card">
      <h2>{title}</h2>
      {totals.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className="total-list">
          {totals.slice(0, TOP_N).map((total) => (
            <li key={total.name}>
              <span className="total-name" title={total.name}>
                {total.name}
              </span>
              <span className="total-ms">{formatDuration(total.ms)}</span>
              <span
                className="total-bar"
                style={{
                  width: `${(total.ms / largest) * 100}%`,
                  background: coloured ? colourFor(total.name) : undefined,
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Picks the hours the timeline shows: whole hours around the recorded activity.
 * @param report The day.
 * @returns The first and last moment shown.
 */
function visibleRange(report: DayReport): { from: number; to: number } {
  const first = report.timeline[0]?.start ?? report.dayStart;
  const last = Math.max(...report.timeline.map((item) => item.end), first + HOUR);
  const from = Math.max(report.dayStart, report.dayStart + Math.floor((first - report.dayStart) / HOUR) * HOUR);
  const to = Math.min(report.dayEnd, report.dayStart + Math.ceil((last - report.dayStart) / HOUR) * HOUR);
  return { from, to: Math.max(to, from + HOUR) };
}

/**
 * A row of thumbnails under the timeline, each one the screenshot nearest the middle of its slice of the
 * visible hours, so the strip lines up with the bar above. Clicking one picks its moment.
 * @param props.shots The day's screenshots.
 * @param props.from The first moment the timeline shows.
 * @param props.to The last moment it shows.
 * @param props.selected The picked moment, if any; its slice is highlighted.
 * @param props.onSelect Called with the clicked thumbnail's moment.
 */
function ThumbStrip({
  shots,
  from,
  to,
  selected,
  onSelect,
}: {
  shots: ScreenshotInfo[];
  from: number;
  to: number;
  selected: number | null;
  onSelect: (moment: number) => void;
}) {
  const slot = (to - from) / STRIP_SLOTS;
  const picks = useMemo(
    () =>
      Array.from({ length: STRIP_SLOTS }, (_, index) =>
        nearestShotIn(shots, from + index * slot, from + (index + 1) * slot),
      ),
    [shots, from, slot],
  );
  if (picks.every((shot) => shot === null)) {
    return null;
  }
  return (
    <div className="thumb-strip">
      {picks.map((shot, index) => {
        const sliceStart = from + index * slot;
        const current = selected !== null && sliceStart <= selected && selected < sliceStart + slot;
        return shot ? (
          <button
            key={index}
            className={`thumb${current ? " current" : ""}`}
            onClick={() => onSelect(shot.takenAt)}
            title={`Screenshot at ${formatClock(shot.takenAt)}`}
          >
            <img src={screenshotUrl(shot.id, "thumb")} alt={`Screenshot at ${formatClock(shot.takenAt)}`} />
          </button>
        ) : (
          <span key={index} className="thumb empty" />
        );
      })}
    </div>
  );
}

/**
 * Writes the tooltip for one stretch of the timeline.
 * @param item The stretch.
 * @returns e.g. "9:31 AM – 9:47 AM · Coding · WebStorm — time-center – PLAN.md".
 */
function describeItem(item: TimelineItem): string {
  const when = `${formatClock(item.start)} – ${formatClock(item.end)}`;
  const what = item.kind === "active" ? [item.app, item.title].filter(Boolean).join(" — ") : "";
  return [when, item.category, what].filter(Boolean).join(" · ");
}

/**
 * Finds the screenshots of every display taken closest to a moment.
 * @param shots The day's screenshots.
 * @param moment The moment.
 * @returns That minute's screenshots, or none if the closest is too far away.
 */
function shotsNear(shots: ScreenshotInfo[], moment: number): ScreenshotInfo[] {
  let best: number | null = null;
  for (const shot of shots) {
    if (shot.status === "taken" && (best === null || Math.abs(shot.takenAt - moment) < Math.abs(best - moment))) {
      best = shot.takenAt;
    }
  }
  if (best === null || Math.abs(best - moment) > SHOT_MATCH_MS) {
    return [];
  }
  return shots.filter((shot) => shot.status === "taken" && shot.takenAt === best);
}

/**
 * Finds the screenshot taken closest to the middle of a slice of time, from the first display listed.
 * @param shots The day's screenshots, oldest first.
 * @param start The slice's start.
 * @param end The slice's end (exclusive).
 * @returns The screenshot, or null when none was taken in the slice.
 */
function nearestShotIn(shots: ScreenshotInfo[], start: number, end: number): ScreenshotInfo | null {
  const middle = (start + end) / 2;
  let best: ScreenshotInfo | null = null;
  for (const shot of shots) {
    if (shot.status !== "taken" || shot.takenAt < start || shot.takenAt >= end) {
      continue;
    }
    if (!best || Math.abs(shot.takenAt - middle) < Math.abs(best.takenAt - middle)) {
      best = shot;
    }
  }
  return best;
}
