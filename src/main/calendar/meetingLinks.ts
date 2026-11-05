import type { MeetingProvider } from "../../shared/ipc";

/** The parts of a Google Calendar event this app reads (the API's `fields` filter asks for just these). */
export interface GoogleEvent {
  id: string;
  /** Set on each occurrence of a repeating meeting: the series it belongs to. */
  recurringEventId?: string;
  status?: string;
  summary?: string;
  eventType?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  description?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  attendees?: { email?: string; displayName?: string; self?: boolean; resource?: boolean; responseStatus?: string }[];
}

/** Someone else invited to a meeting. */
export interface Attendee {
  email: string;
  /** Their name, when Google knows it. */
  name: string | null;
}

/** A meeting as the app keeps it. Times are milliseconds since 1970. */
export interface CalendarEvent {
  eventId: string;
  title: string;
  start: number;
  end: number;
  /** Your answer to the invitation: accepted, tentative, needsAction or declined. */
  response: string;
  provider: MeetingProvider | null;
  joinUrl: string | null;
  /** The repeating meeting this occurrence belongs to, or its own id when it doesn't repeat. */
  seriesId: string;
  /** The other people invited, without you, rooms, or anyone who declined. */
  attendees: Attendee[];
}

/** A meeting link found in an event. */
export interface MeetingLink {
  provider: MeetingProvider;
  url: string;
}

/** Event types that are blocks of time rather than meetings, so never joined. */
const NOT_MEETINGS = new Set(["outOfOffice", "focusTime", "workingLocation", "birthday"]);

/** Any web address, for picking addresses out of a location or a description. */
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;

/**
 * Turns a Google Calendar event into a meeting, or null for what can't be joined at a set time: all-day
 * events, cancelled ones, and blocks such as focus time or out of office.
 * @param raw The event from the Calendar API.
 * @returns The meeting, or null.
 */
export function toCalendarEvent(raw: GoogleEvent): CalendarEvent | null {
  const start = raw.start?.dateTime ? Date.parse(raw.start.dateTime) : NaN;
  const end = raw.end?.dateTime ? Date.parse(raw.end.dateTime) : NaN;
  if (raw.status === "cancelled" || NOT_MEETINGS.has(raw.eventType ?? "") || Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }
  const link = findMeetingLink(raw);
  return {
    eventId: raw.id,
    title: raw.summary?.trim() || "(No title)",
    start,
    end,
    response: raw.attendees?.find((attendee) => attendee.self)?.responseStatus ?? "accepted",
    provider: link?.provider ?? null,
    joinUrl: link?.url ?? null,
    seriesId: raw.recurringEventId ?? raw.id,
    attendees: (raw.attendees ?? [])
      // Someone who declined isn't coming, so a 1:1 with a third person who said no is still a 1:1.
      .filter((attendee) => !attendee.self && !attendee.resource && attendee.email && attendee.responseStatus !== "declined")
      .map((attendee) => ({ email: attendee.email as string, name: attendee.displayName?.trim() || null })),
  };
}

/**
 * Finds the event's meeting link: the conference Google attached (Meet, or a Zoom/Teams add-on) first,
 * then a Meet link, then the first Zoom, Teams or Meet address in the location or the description.
 * @param raw The event.
 * @returns The link, or null when there is none.
 */
export function findMeetingLink(raw: GoogleEvent): MeetingLink | null {
  const conference = (raw.conferenceData?.entryPoints ?? [])
    .filter((entry) => entry.entryPointType === "video" && entry.uri)
    .map((entry) => entry.uri as string);
  const written = [raw.location ?? "", raw.description ?? ""].flatMap((text) =>
    Array.from(decodeEntities(text).matchAll(URL_PATTERN), (match) => match[0]),
  );
  for (const candidate of [...conference, raw.hangoutLink ?? "", ...written]) {
    const link = classifyMeetingUrl(candidate);
    if (link) {
      return link;
    }
  }
  return null;
}

/**
 * Says which meeting service an address belongs to.
 * @param candidate The address, possibly with trailing punctuation from the text around it.
 * @returns The link, cleaned, or null when it isn't a meeting address.
 */
export function classifyMeetingUrl(candidate: string): MeetingLink | null {
  const cleaned = candidate.replace(/[).,;:!?\]]+$/, "");
  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    return null;
  }
  // Only https: a link from a conferencing add-on could otherwise carry file:// or a custom scheme.
  if (url.protocol !== "https:") {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (host === "meet.google.com" && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(path)) {
    return { provider: "meet", url: url.toString() };
  }
  if (/(^|\.)zoom(gov)?\.(us|com)$/.test(host) && /^\/(j|w|my|s)\//.test(path)) {
    return { provider: "zoom", url: url.toString() };
  }
  if (/^teams\.((microsoft|live)\.com|cloud\.microsoft)$/.test(host) && /^\/(l\/meetup-join|meet)\//.test(path)) {
    return { provider: "teams", url: url.toString() };
  }
  return null;
}

/**
 * Says whether a meeting gets joined automatically: it has a link and you didn't decline it (accepted,
 * maybe and not-yet-answered all count — the user's pick).
 * @param event The meeting.
 * @returns True when it should be joined.
 */
export function shouldJoin(event: CalendarEvent): boolean {
  return event.joinUrl !== null && event.response !== "declined";
}

/**
 * Works out what to open to join. Zoom opens straight in the Zoom app via its `zoommtg://` link when the
 * address carries a meeting number; Meet and Teams open in Chrome, on the meeting's page, where you click
 * Join.
 * @param event The meeting.
 * @param account The calendar's Google account, so Meet opens signed in as that account.
 * @returns Where to open it: the Zoom app, or Chrome.
 */
export function joinTarget(event: CalendarEvent, account: string | null): { app: "zoom" | "chrome"; url: string } {
  const url = new URL(event.joinUrl ?? "");
  if (event.provider === "zoom") {
    const meetingNumber = url.pathname.match(/^\/[jw]\/(\d+)/)?.[1];
    if (meetingNumber) {
      const deepLink = new URL(`zoommtg://${url.hostname}/join`);
      deepLink.searchParams.set("action", "join");
      deepLink.searchParams.set("confno", meetingNumber);
      // pwd is the meeting password; tk is a registered webinar attendee's token.
      for (const name of ["pwd", "tk"]) {
        const value = url.searchParams.get(name);
        if (value) {
          deepLink.searchParams.set(name, value);
        }
      }
      return { app: "zoom", url: deepLink.toString() };
    }
    // A personal link (/my/name) has no number to hand the app, so Zoom's web page opens the app instead.
    return { app: "chrome", url: url.toString() };
  }
  if (event.provider === "meet" && account) {
    url.searchParams.set("authuser", account);
  }
  return { app: "chrome", url: url.toString() };
}

/**
 * Undoes the HTML escaping Google uses in descriptions, so `&amp;` in a link becomes `&` again.
 * @param text The text.
 * @returns It, unescaped.
 */
function decodeEntities(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
