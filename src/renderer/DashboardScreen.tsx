import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { screenshotUrl, type DayReport, type ScreenshotInfo, type TimelineItem, type Total } from "../shared/ipc";
import { colourFor, formatClock, formatDay, formatDuration } from "./format";
import { MINUTE, SHIFT_STEP, stepMoment, stepToChange } from "./timelineStep";
import { keepInView, panRange, tickMoments, zoomRange, type TimeRange } from "./timelineZoom";
import { UNCATEGORIZED } from "./uncategorized";
import { AddEntryPanel } from "./AddEntryPanel";
import { snapRange } from "./manualEntry";
import { MeetingTypesCard } from "./MeetingTypesCard";
import { ShotLightbox } from "./ShotLightbox";
import { UncategorizedPanel } from "./UncategorizedPanel";

/** While showing today, the dashboard re-reads the day this often. */
const REFRESH_MS = 30_000;

/** A screenshot counts as "at" the picked moment if it was taken within this long of it. */
const SHOT_MATCH_MS = 45_000;

/** How many rows each totals card lists. */
const TOP_N = 8;

/** One hour, in milliseconds: the timeline's grid. */
const HOUR = 3_600_000;

/** How many thumbnails the strip under the timeline shows, one per equal slice of the visible hours. */
const STRIP_SLOTS = 10;

/** How far the pointer must move with the button down before a click on the timeline becomes a drag. */
const DRAG_THRESHOLD_PX = 4;

/**
 * One day of your time: how long you worked, were away, or were in an ignored app; a timeline coloured
 * by category that you click to see that moment's screenshots and window; and totals by category, app,
 * project and website.
 */
export function DashboardScreen() {
  const [at, setAt] = useState(() => Date.now());
  const [report, setReport] = useState<DayReport | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  /** The zoomed-in stretch of the timeline, or null for the whole day. */
  const [zoom, setZoom] = useState<TimeRange | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Whether the list of uncategorized time, opened from the Categories card, is showing. */
  const [showUncategorized, setShowUncategorized] = useState(false);
  /** The stretch dragged out on the timeline to add an entry for, or null. */
  const [adding, setAdding] = useState<TimeRange | null>(null);
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
        setZoom(null);
        setAdding(null);
        return;
      }
      void load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [at, load]);

  useEffect(() => {
    /**
     * Left and Right move the picked moment to the previous or next change of app or activity; with Shift,
     * ten minutes; with Ctrl, one minute. Option does the same as Ctrl, since macOS keeps Ctrl + arrow for
     * switching desktops when that shortcut is on. Escape closes the panel for marking a stretch.
     * @param event The key press.
     */
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAdding(null);
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }
      if (!report || report.timeline.length === 0 || event.metaKey || isTyping(event.target)) {
        return;
      }
      event.preventDefault();
      const full = visibleRange(report);
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      const start = selected ?? latestShot(report.screenshots) ?? full.to;
      let next: number;
      if (event.shiftKey) {
        next = stepMoment(start, direction, SHIFT_STEP, full.from, full.to);
      } else if (event.ctrlKey || event.altKey) {
        next = stepMoment(start, direction, MINUTE, full.from, full.to);
      } else {
        next = stepToChange(report.timeline, start, direction);
      }
      setSelected(next);
      setZoom((current) => (current ? keepInView(current, full, next) : current));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [report, selected]);

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
    setZoom(null);
    setAdding(null);
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
              setZoom(null);
              setAdding(null);
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
          <Timeline
            report={report}
            selected={selected}
            onSelect={setSelected}
            zoom={zoom}
            onZoom={setZoom}
            marked={adding}
            onMark={setAdding}
          />
          {adding && (
            <AddEntryPanel range={adding} report={report} onClose={() => setAdding(null)} onSaved={() => void load()} />
          )}
          <MomentPanel
            report={report}
            selected={selected ?? latestShot(report.screenshots) ?? null}
            onChanged={() => void load()}
          />
          <div className="totals">
            <TotalsCard
              title="Categories"
              totals={report.byCategory}
              coloured
              onPick={(name) => {
                if (name === UNCATEGORIZED) {
                  setShowUncategorized(true);
                }
              }}
              pickable={(name) => name === UNCATEGORIZED}
            />
            <TotalsCard title="Apps" totals={report.byApp} />
            <TotalsCard title="Projects" totals={report.byProject} empty="No WebStorm projects" />
            <TotalsCard title="Websites" totals={report.byDomain} empty="No Chrome tabs" />
          </div>
          {report.meetings.length > 0 && <MeetingTypesCard meetings={report.meetings} onChanged={() => void load()} />}
          {showUncategorized && (
            <UncategorizedPanel
              timeline={report.timeline}
              onClose={() => setShowUncategorized(false)}
              onRuleAdded={() => void load()}
            />
          )}
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
 * Says whether a key press is going into a text box, where arrows must move the text cursor instead.
 * @param target Where the key press landed.
 * @returns True for inputs, text areas, drop-downs and editable text.
 */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
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
 * every moment that has a screenshot and a strip of thumbnails below. Clicking picks a moment. Once one is
 * picked, the scroll wheel zooms in and out around it and a sideways swipe pans; double-click shows the
 * whole day again. Dragging across the bar marks a stretch, to say what you were doing while away.
 * @param props.report The day.
 * @param props.selected The picked moment, if any.
 * @param props.onSelect Called with the moment clicked.
 * @param props.zoom The zoomed-in stretch, or null for the whole day.
 * @param props.onZoom Called with the new stretch, or null for the whole day.
 * @param props.marked The stretch being added, shaded on the bar, or null.
 * @param props.onMark Called with a stretch dragged out on the bar.
 */
function Timeline({
  report,
  selected,
  onSelect,
  zoom,
  onZoom,
  marked,
  onMark,
}: {
  report: DayReport;
  selected: number | null;
  onSelect: (moment: number) => void;
  zoom: TimeRange | null;
  onZoom: (range: TimeRange | null) => void;
  marked: TimeRange | null;
  onMark: (range: TimeRange) => void;
}) {
  const full = visibleRange(report);
  const { from, to } = zoom ?? full;
  const span = to - from;
  const bar = useRef<HTMLDivElement>(null);
  /** The stretch under a drag in progress. */
  const [dragging, setDragging] = useState<TimeRange | null>(null);
  /** Set when a drag ends, so the click that follows the release doesn't also pick a moment. */
  const dragged = useRef(false);
  /** Ends the drag in progress, or null when there is none. */
  const endDrag = useRef<(() => void) | null>(null);

  // A drag still going when the timeline goes away (the day changed) is dropped, not marked.
  useEffect(() => () => endDrag.current?.(), []);
  /**
   * Places a moment along the bar.
   * @param ms The moment.
   * @returns Its distance from the left edge, as a CSS percentage.
   */
  const percent = (ms: number) => `${((ms - from) / span) * 100}%`;
  const ticks = useMemo(() => tickMoments({ from, to }, report.dayStart), [from, to, report.dayStart]);
  const shotMoments = useMemo(
    () => [
      ...new Set(
        report.screenshots
          .filter((shot) => shot.status === "taken" && shot.takenAt >= from && shot.takenAt <= to)
          .map((shot) => shot.takenAt),
      ),
    ],
    [report.screenshots, from, to],
  );

  useEffect(() => {
    const element = bar.current;
    if (!element || selected === null) {
      return undefined;
    }
    /**
     * Scrolling up or down zooms around the picked moment (or the pointer, if the picked moment is off the
     * bar); scrolling sideways pans. Registered by hand because React's wheel handler can't stop the page
     * scrolling.
     * @param event The wheel turn or trackpad swipe.
     */
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (endDrag.current) {
        // Zooming mid-drag would move the bar under the stretch being dragged.
        return;
      }
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 33 : 1;
      const box = element.getBoundingClientRect();
      const view = { from, to };
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        onZoom(panRange(view, full, ((event.deltaX * scale) / box.width) * span));
        return;
      }
      const pointer = from + ((event.clientX - box.left) / box.width) * span;
      const anchor = selected >= from && selected <= to ? selected : pointer;
      const next = zoomRange(view, full, anchor, event.deltaY * scale);
      onZoom(next.from === full.from && next.to === full.to ? null : next);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [selected, from, to, span, full.from, full.to, onZoom]);

  /**
   * Turns a click on the bar into a moment. A click that ends a drag picks nothing.
   * @param event The click.
   */
  const pick = (event: MouseEvent<HTMLDivElement>) => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    const box = event.currentTarget.getBoundingClientRect();
    onSelect(from + ((event.clientX - box.left) / box.width) * span);
  };

  /**
   * Starts dragging out a stretch to mark. Moving and letting go are followed on the whole window, so the
   * drag keeps going when the pointer leaves the bar.
   * @param event The mouse press.
   */
  const startDrag = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    // Stops the press selecting text across the page while dragging.
    event.preventDefault();
    dragged.current = false;
    const box = event.currentTarget.getBoundingClientRect();
    /**
     * Turns a spot on the bar into a moment, at the scale the bar had when the drag began.
     * @param x The pointer's distance from the window's left edge.
     * @returns The moment.
     */
    const momentAt = (x: number) => from + ((x - box.left) / box.width) * span;
    const startX = event.clientX;
    const anchor = momentAt(startX);
    let range: TimeRange | null = null;
    /**
     * Stretches the drag to the pointer once it has moved far enough to be a drag rather than a click.
     * @param move The pointer moving with the button held.
     */
    const onMove = (move: globalThis.MouseEvent) => {
      if (range === null && Math.abs(move.clientX - startX) < DRAG_THRESHOLD_PX) {
        return;
      }
      // Not past now: a stretch in the future would be a guess, not a record.
      range = snapRange(anchor, momentAt(move.clientX), { from, to: Math.min(to, Date.now()) });
      setDragging(range);
    };
    /** Ends the drag and hands on the stretch, if it's at least a minute long. */
    const onUp = () => {
      stopDrag();
      if (range !== null) {
        dragged.current = true;
        if (range.to > range.from) {
          onMark(range);
        }
      }
    };
    /**
     * Escape drops the drag without marking anything.
     * @param key The key press.
     */
    const onKey = (key: KeyboardEvent) => {
      if (key.key === "Escape") {
        stopDrag();
      }
    };
    /** Stops following the pointer and clears the shaded stretch. */
    const stopDrag = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
      endDrag.current = null;
      setDragging(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    endDrag.current = stopDrag;
  };
  const shown = dragging ?? marked;

  return (
    <div className="timeline">
      <div className="timeline-zoom">
        {zoom ? (
          <>
            <span>
              Zoomed to {formatClock(from)} – {formatClock(to)}
            </span>
            <button className="link" onClick={() => onZoom(null)}>
              Show whole day
            </button>
            <span>· Drag across grey time to add a phone call or drive</span>
          </>
        ) : (
          <span>
            {selected !== null && "Scroll on the timeline to zoom in · "}Drag across grey time to add a phone call or drive
          </span>
        )}
      </div>
      <div
        className="timeline-bar"
        ref={bar}
        onMouseDown={startDrag}
        onClick={pick}
        onDoubleClick={() => onZoom(null)}
        role="presentation"
      >
        {report.timeline.map((item, index) => (
          <div
            key={index}
            className={`timeline-item ${item.kind}${item.manual ? " manual" : ""}`}
            style={{
              left: percent(item.start),
              width: percent(from + (item.end - item.start)),
              background: colourFor(item.category),
            }}
            title={describeItem(item)}
          />
        ))}
        {shown && (
          <div className="timeline-draft" style={{ left: percent(shown.from), width: percent(from + (shown.to - shown.from)) }} />
        )}
        {selected !== null && <div className="timeline-cursor" style={{ left: percent(selected) }} />}
      </div>
      <div className="timeline-shots">
        {shotMoments.map((moment) => (
          <span key={moment} style={{ left: percent(moment) }} />
        ))}
      </div>
      <div className="timeline-hours">
        {ticks.map((tick) => (
          <span key={tick} style={{ left: percent(tick) }}>
            {new Date(tick).getMinutes() === 0
              ? new Date(tick).toLocaleTimeString(undefined, { hour: "numeric" })
              : new Date(tick).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
          </span>
        ))}
      </div>
      <ThumbStrip shots={report.screenshots} from={from} to={to} selected={selected} onSelect={onSelect} />
    </div>
  );
}

/**
 * What was going on at the picked moment: the window in front and the nearest screenshots. On a stretch
 * you added yourself, a Remove button takes it off again.
 * @param props.report The day.
 * @param props.selected The moment, or null when nothing is picked and there are no screenshots.
 * @param props.onChanged Called after an added stretch is removed, to re-read the day.
 */
function MomentPanel({
  report,
  selected,
  onChanged,
}: {
  report: DayReport;
  selected: number | null;
  onChanged: () => void;
}) {
  const [zoomed, setZoomed] = useState<number | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  if (selected === null) {
    return <p className="hint">Click the timeline, or press ← → to jump between apps, to see what you were doing at that moment.</p>;
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
            {item.manual ? (
              <>
                <span className="muted">Added by you{item.manual.eventId ? ` · ${meetingTitle(report, item.manual.eventId)}` : ""}</span>
                <button
                  className="link"
                  onClick={() => {
                    const id = item.manual?.id;
                    if (id !== undefined) {
                      setRemoveError(null);
                      window.timeCenter
                        .deleteManualEntry(id)
                        .then(onChanged)
                        .catch((error: unknown) => setRemoveError(`Couldn't remove it: ${String(error)}`));
                    }
                  }}
                >
                  Remove
                </button>
                {removeError && <span className="error">{removeError}</span>}
              </>
            ) : (
              <span>{item.kind === "active" ? [item.app, item.title].filter(Boolean).join(" — ") : ""}</span>
            )}
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
        <p className="muted">No screenshot within 45 seconds of this moment.</p>
      )}
      {zoomed !== null && <ShotLightbox id={zoomed} onClose={() => setZoomed(null)} />}
    </div>
  );
}

/**
 * Names the calendar meeting an added stretch belongs to.
 * @param report The day.
 * @param eventId The meeting's id.
 * @returns Its title, or a stand-in when it's no longer on the calendar.
 */
function meetingTitle(report: DayReport, eventId: string): string {
  return report.allMeetings.find((meeting) => meeting.eventId === eventId)?.title ?? "a meeting no longer on your calendar";
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
 * @param props.pickable Says which names can be clicked; none can when left out.
 * @param props.onPick Called with a clicked name.
 */
function TotalsCard({
  title,
  totals,
  coloured = false,
  empty = "Nothing yet",
  pickable = () => false,
  onPick = () => {},
}: {
  title: string;
  totals: Total[];
  coloured?: boolean;
  empty?: string;
  pickable?: (name: string) => boolean;
  onPick?: (name: string) => void;
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
              {pickable(total.name) ? (
                <button className="link total-name" title={`See what's in ${total.name}`} onClick={() => onPick(total.name)}>
                  {total.name}
                </button>
              ) : (
                <span className="total-name" title={total.name}>
                  {total.name}
                </span>
              )}
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
 * Picks the hours the timeline shows: whole hours around the recorded activity, reaching back to the
 * day's first calendar block so a call or drive before the Mac woke up can still be dragged out.
 * @param report The day.
 * @returns The first and last moment shown.
 */
function visibleRange(report: DayReport): { from: number; to: number } {
  const first = Math.min(
    report.timeline[0]?.start ?? report.dayStart,
    ...report.allMeetings.filter((meeting) => meeting.start < Date.now()).map((meeting) => meeting.start),
  );
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
 * @returns Those screenshots, or none if the closest is too far away.
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
