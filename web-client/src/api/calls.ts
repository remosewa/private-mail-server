/**
 * Video call API — Amazon Chime SDK meetings.
 *
 * createCall() requires a logged-in session (JWT). joinCall()/endCall() are
 * public endpoints: the axios client simply sends no Authorization header when
 * there is no session, so guests with just the link can call them.
 */

import { apiClient } from './client';

/**
 * Chime Meeting / Attendee response shapes. Passed verbatim to
 * MeetingSessionConfiguration, which knows how to read them — the attendee's
 * JoinToken is the only credential the browser holds.
 */
export interface ChimeMeeting {
  MeetingId: string;
  MediaPlacement: Record<string, string>;
  MediaRegion: string;
  [key: string]: unknown;
}

export interface ChimeAttendee {
  AttendeeId: string;
  ExternalUserId: string;
  JoinToken: string;
  [key: string]: unknown;
}

export interface JoinCallResponse {
  role: 'HOST' | 'GUEST';
  meeting: ChimeMeeting;
  attendee: ChimeAttendee;
}

export async function createCall(): Promise<{ callId: string; hostToken: string }> {
  const { data } = await apiClient.post<{ callId: string; hostToken: string }>('/calls');
  return data;
}

export async function joinCall(
  callId: string,
  opts: { hostToken?: string; name?: string } = {},
): Promise<JoinCallResponse> {
  const { data } = await apiClient.get<JoinCallResponse>(`/calls/${callId}/join`, {
    params: {
      ...(opts.hostToken ? { hostToken: opts.hostToken } : {}),
      ...(opts.name ? { name: opts.name } : {}),
    },
  });
  return data;
}

export async function endCall(callId: string, hostToken: string): Promise<void> {
  await apiClient.delete(`/calls/${callId}`, { params: { hostToken } });
}

export interface ScheduleMeetingInput {
  title: string;
  /** ISO 8601 start time (UTC). */
  startsAt: string;
  durationMinutes: number;
  attendees: string[];
  notes?: string;
}

export interface ScheduleMeetingResponse {
  callId: string;
  hostToken: string;
  hostUrl: string;
  joinUrl: string;
  scheduledStart: string;
  scheduledEnd: string;
  invited: string[];
}

/**
 * Schedule a meeting for later. The server creates a durable call link and
 * emails an iCalendar invite (for the given date/time) to the attendees and
 * the organizer. Returns the host link so the organizer can start/control it.
 */
export async function scheduleCall(input: ScheduleMeetingInput): Promise<ScheduleMeetingResponse> {
  const { data } = await apiClient.post<ScheduleMeetingResponse>('/calls/schedule', input);
  return data;
}
