import {
  classifyMeetingUrl,
  classifyWrappedMeetingUrl,
  findMeetingLink,
  joinTarget,
  shouldJoin,
  toCalendarEvent,
  type CalendarEvent,
  type GoogleEvent,
} from "../../src/main/calendar/meetingLinks";

describe("findMeetingLink", () => {
  it("should prefer the conference Google attached over links in the text", () => {
    const link = findMeetingLink({
      id: "1",
      conferenceData: {
        entryPoints: [
          { entryPointType: "phone", uri: "tel:+1-555-0100" },
          { entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" },
        ],
      },
      description: "Backup: https://zoom.us/j/123",
    });
    expect(link).toEqual({ provider: "meet", url: "https://meet.google.com/abc-defg-hij" });
  });

  it("should find a Zoom link with its password inside an HTML description", () => {
    const link = findMeetingLink({
      id: "1",
      description: '<a href="https://us02web.zoom.us/j/8812345678?pwd=Xy12&amp;from=addon">Join Zoom</a>',
    });
    expect(link).toEqual({ provider: "zoom", url: "https://us02web.zoom.us/j/8812345678?pwd=Xy12&from=addon" });
  });

  it("should find a Teams link in the location", () => {
    const link = findMeetingLink({
      id: "1",
      location: "Microsoft Teams Meeting (https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=y).",
    });
    expect(link?.provider).toBe("teams");
    expect(link?.url).toBe("https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=y");
  });

  it("should ignore addresses that aren't meetings", () => {
    expect(findMeetingLink({ id: "1", description: "Agenda: https://docs.google.com/x and https://zoom.us/pricing" })).toBeNull();
  });

  it("should find the Join link of a Teams invite whose links Mimecast wrapped", () => {
    // Trimmed from a real invite (2026-11-06): the Join link comes before the help and System reference links.
    const join = "https://url.usb.m.mimecastprotect.com/s/osCUC2GpzGCRKrXcnf3ws5g92N?domain=teams.microsoft.com";
    const link = findMeetingLink({
      id: "1",
      location: "#Parkwood-4-4711-Conf RM (250 West 96th Street Indianapolis)",
      description:
        "Microsoft Teams meeting<br>Join: <a href=\"" + join + "\">" + join + "</a><br>Meeting ID: 253 056 728 165 647<br>" +
        "Need help? <https://url.usb.m.mimecastprotect.com/s/hKMMC3YqBYhG73lSqhZEsQmFLf?domain=aka.ms> | System " +
        "reference<https://url.usb.m.mimecastprotect.com/s/iPBBC4WrEWtmYPOHBiGXs4Zn03?domain=teams.microsoft.com>",
    });
    expect(link).toEqual({ provider: "teams", url: join });
  });

  it("should prefer an unwrapped meeting link over a Mimecast-wrapped one", () => {
    const link = findMeetingLink({
      id: "1",
      description:
        "Old: https://url.usb.m.mimecastprotect.com/s/abc?domain=teams.microsoft.com New: https://zoom.us/j/123",
    });
    expect(link).toEqual({ provider: "zoom", url: "https://zoom.us/j/123" });
  });
});

describe("classifyWrappedMeetingUrl", () => {
  it("should name the service from the wrapper's domain", () => {
    expect(classifyWrappedMeetingUrl("https://url.us.m.mimecastprotect.com/s/x?domain=us02web.zoom.us")?.provider).toBe("zoom");
    expect(classifyWrappedMeetingUrl("https://protect-us.mimecast.com/s/x?domain=meet.google.com")?.provider).toBe("meet");
  });

  it("should refuse wrapped links to other sites, and look-alike hosts", () => {
    expect(classifyWrappedMeetingUrl("https://url.usb.m.mimecastprotect.com/s/x?domain=aka.ms")).toBeNull();
    expect(classifyWrappedMeetingUrl("https://url.usb.m.mimecastprotect.com/s/x")).toBeNull();
    expect(classifyWrappedMeetingUrl("https://mimecastprotect.com.evil.example/s/x?domain=teams.microsoft.com")).toBeNull();
    expect(classifyWrappedMeetingUrl("http://url.usb.m.mimecastprotect.com/s/x?domain=teams.microsoft.com")).toBeNull();
  });
});

describe("classifyMeetingUrl", () => {
  it("should accept Zoom personal links and government Zoom", () => {
    expect(classifyMeetingUrl("https://acme.zoom.us/my/ryan")?.provider).toBe("zoom");
    expect(classifyMeetingUrl("https://agency.zoomgov.com/j/161000")?.provider).toBe("zoom");
  });

  it("should accept the newer Teams address for work accounts", () => {
    expect(classifyMeetingUrl("https://teams.cloud.microsoft/l/meetup-join/19%3a/0")?.provider).toBe("teams");
  });

  it("should refuse any scheme but https, even on a meeting host", () => {
    expect(classifyMeetingUrl("file://meet.google.com/abc-defg-hij")).toBeNull();
    expect(classifyMeetingUrl("http://meet.google.com/abc-defg-hij")).toBeNull();
    expect(classifyMeetingUrl("zoommtg://zoom.us/j/123")).toBeNull();
  });

  it("should refuse text that isn't an address", () => {
    expect(classifyMeetingUrl("meet.google.com/abc-defg-hij")).toBeNull();
  });
});

describe("toCalendarEvent", () => {
  const base: GoogleEvent = {
    id: "evt1",
    summary: "Standup",
    start: { dateTime: "2026-11-05T15:00:00Z" },
    end: { dateTime: "2026-11-05T15:15:00Z" },
    hangoutLink: "https://meet.google.com/abc-defg-hij",
  };

  it("should read the title, times, link, your answer, the series and the other guests", () => {
    const event = toCalendarEvent({
      ...base,
      recurringEventId: "series1",
      attendees: [
        { email: "sam@acme.com", displayName: " Sam Lee ", responseStatus: "accepted" },
        { email: "kim@qbdvision.com" },
        { email: "ryan@qbdvision.com", self: true, responseStatus: "tentative" },
        { email: "room-4@resource.calendar.google.com", resource: true },
        { email: "lee@qbdvision.com", responseStatus: "declined" },
      ],
    });
    expect(event).toEqual({
      eventId: "evt1",
      title: "Standup",
      start: Date.parse("2026-11-05T15:00:00Z"),
      end: Date.parse("2026-11-05T15:15:00Z"),
      response: "tentative",
      provider: "meet",
      joinUrl: "https://meet.google.com/abc-defg-hij",
      seriesId: "series1",
      attendees: [
        { email: "sam@acme.com", name: "Sam Lee" },
        { email: "kim@qbdvision.com", name: null },
      ],
    });
  });

  it("should use its own id as the series when the meeting doesn't repeat", () => {
    expect(toCalendarEvent(base)?.seriesId).toBe("evt1");
  });

  it("should count an event with no guests as accepted", () => {
    expect(toCalendarEvent(base)?.response).toBe("accepted");
  });

  it("should leave out all-day events, cancelled ones and focus time", () => {
    expect(toCalendarEvent({ ...base, start: { date: "2026-11-05" }, end: { date: "2026-11-06" } })).toBeNull();
    expect(toCalendarEvent({ ...base, status: "cancelled" })).toBeNull();
    expect(toCalendarEvent({ ...base, eventType: "focusTime" })).toBeNull();
  });
});

describe("shouldJoin", () => {
  it("should join accepted, maybe and unanswered meetings but not declined ones or ones with no link", () => {
    const event = toCalendarEvent({
      id: "1",
      start: { dateTime: "2026-11-05T15:00:00Z" },
      end: { dateTime: "2026-11-05T16:00:00Z" },
      hangoutLink: "https://meet.google.com/abc-defg-hij",
    }) as CalendarEvent;
    expect(["accepted", "tentative", "needsAction"].map((response) => shouldJoin({ ...event, response }))).toEqual([true, true, true]);
    expect(shouldJoin({ ...event, response: "declined" })).toBe(false);
    expect(shouldJoin({ ...event, joinUrl: null })).toBe(false);
  });
});

describe("joinTarget", () => {
  const meeting = (provider: CalendarEvent["provider"], joinUrl: string): CalendarEvent => ({
    eventId: "1",
    title: "T",
    start: 0,
    end: 1,
    response: "accepted",
    provider,
    joinUrl,
    seriesId: "1",
    attendees: [],
  });

  it("should open a Zoom meeting in the Zoom app with its number, password and webinar token", () => {
    expect(joinTarget(meeting("zoom", "https://us02web.zoom.us/j/8812345678?pwd=Xy12&tk=T9"), null)).toEqual({
      app: "zoom",
      url: "zoommtg://us02web.zoom.us/join?action=join&confno=8812345678&pwd=Xy12&tk=T9",
    });
  });

  it("should open a Zoom personal link in Chrome, since it has no number to hand the app", () => {
    expect(joinTarget(meeting("zoom", "https://acme.zoom.us/my/ryan"), null)).toEqual({
      app: "chrome",
      url: "https://acme.zoom.us/my/ryan",
    });
  });

  it("should open Meet in Chrome as the calendar's account", () => {
    expect(joinTarget(meeting("meet", "https://meet.google.com/abc-defg-hij"), "ryan@example.com")).toEqual({
      app: "chrome",
      url: "https://meet.google.com/abc-defg-hij?authuser=ryan%40example.com",
    });
  });

  it("should open a Teams link in Chrome as it is", () => {
    const target = joinTarget(meeting("teams", "https://teams.microsoft.com/l/meetup-join/abc/0?context=x"), "r@x.com");
    expect(target).toEqual({ app: "chrome", url: "https://teams.microsoft.com/l/meetup-join/abc/0?context=x" });
  });
});
