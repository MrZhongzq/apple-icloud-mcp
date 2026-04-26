import { createDAVClient } from 'tsdav';
export const getCalendarClient = async (account) => {
    return await createDAVClient({
        serverUrl: 'https://caldav.icloud.com/',
        credentials: {
            username: account.email,
            password: account.appPass,
        },
        authMethod: 'Basic',
        defaultAccountType: 'caldav',
    });
};
export const listEvents = async (account, timeRangeStart, timeRangeEnd) => {
    if (!account.allowCalendarRead)
        throw new Error('Calendar read permission denied.');
    const client = await getCalendarClient(account);
    const calendars = await client.fetchCalendars();
    if (!calendars || calendars.length === 0) {
        return [];
    }
    let allEvents = [];
    for (const cal of calendars) {
        // In tsdav, timeRange filter is supported in fetchCalendarObjects
        const objects = await client.fetchCalendarObjects({
            calendar: cal,
            timeRange: timeRangeStart && timeRangeEnd ? {
                start: timeRangeStart, // ISO string e.g. 2026-05-01T00:00:00Z
                end: timeRangeEnd,
            } : undefined
        });
        allEvents = allEvents.concat(objects.map(obj => ({
            calendarId: cal.url,
            url: obj.url,
            etag: obj.etag,
            data: obj.data
        })));
    }
    return allEvents;
};
export const createEvent = async (account, iCalString, filename) => {
    if (!account.allowCalendarWrite)
        throw new Error('Calendar write permission denied.');
    const client = await getCalendarClient(account);
    const calendars = await client.fetchCalendars();
    if (!calendars || calendars.length === 0) {
        throw new Error('No calendars found to create event.');
    }
    // Create on the first calendar or specific one if needed
    // Create on the first calendar that supports VEVENT
    const targetCal = calendars.find((c) => c.components && c.components.includes('VEVENT')) || calendars[0];
    const response = await client.createCalendarObject({
        calendar: targetCal,
        iCalString,
        filename: filename.endsWith('.ics') ? filename : `${filename}.ics`,
    });
    return response;
};
export const updateEvent = async (account, calendarUrl, eventUrl, iCalString, etag) => {
    if (!account.allowCalendarWrite)
        throw new Error('Calendar write permission denied.');
    const client = await getCalendarClient(account);
    const response = await client.updateCalendarObject({
        calendarObject: {
            url: eventUrl,
            etag: etag,
            data: iCalString
        }
    });
    return response;
};
export const deleteEvent = async (account, eventUrl, etag) => {
    if (!account.allowCalendarWrite)
        throw new Error('Calendar write permission denied.');
    const client = await getCalendarClient(account);
    const calendarObject = {
        url: eventUrl,
        etag: etag
    };
    const response = await client.deleteCalendarObject({
        calendarObject: calendarObject
    });
    return response;
};
