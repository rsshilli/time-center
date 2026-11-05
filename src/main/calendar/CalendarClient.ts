import type { GoogleEvent } from "./meetingLinks";

/** The Calendar API's address for the signed-in user's main calendar. */
const PRIMARY_CALENDAR_URL = "https://www.googleapis.com/calendar/v3/calendars/primary";

/** Only the event fields meetingLinks reads, to keep each answer small. */
const EVENT_FIELDS =
  "nextPageToken,items(id,recurringEventId,status,summary,eventType,start,end,location,description,hangoutLink," +
  "conferenceData/entryPoints(entryPointType,uri),attendees(email,displayName,self,resource,responseStatus))";

/**
 * Reads the main Google calendar with an access token. Repeating meetings come back one row per
 * occurrence, sorted by start.
 */
export class CalendarClient {
  /**
   * @param getAccessToken Hands out a current access token.
   * @param fetchImpl The network, injected for tests.
   */
  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /**
   * Lists the events that overlap a time window, following every page of the answer.
   * @param from The window's start, milliseconds since 1970.
   * @param to Its end.
   * @returns The events.
   */
  async listEvents(from: number, to: number): Promise<GoogleEvent[]> {
    const events: GoogleEvent[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${PRIMARY_CALENDAR_URL}/events`);
      url.searchParams.set("timeMin", new Date(from).toISOString());
      url.searchParams.set("timeMax", new Date(to).toISOString());
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("maxResults", "250");
      url.searchParams.set("fields", EVENT_FIELDS);
      if (pageToken) {
        url.searchParams.set("pageToken", pageToken);
      }
      const page = (await this.get(url)) as { items?: GoogleEvent[]; nextPageToken?: string };
      events.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return events;
  }

  /**
   * Finds the main calendar's account, which is its id (the email address).
   * @returns e.g. "ryan@example.com".
   */
  async getAccount(): Promise<string> {
    const url = new URL(PRIMARY_CALENDAR_URL);
    url.searchParams.set("fields", "id");
    return ((await this.get(url)) as { id: string }).id;
  }

  /**
   * Sends a GET with the access token and reads the JSON answer.
   * @param url The address.
   * @returns The parsed body.
   */
  private async get(url: URL): Promise<unknown> {
    const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${await this.getAccessToken()}` } });
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!response.ok) {
      throw new Error(`Google Calendar said: ${body.error?.message ?? `HTTP ${response.status}`}`);
    }
    return body;
  }
}
