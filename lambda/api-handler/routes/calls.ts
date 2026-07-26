/**
 * Video call routes — Amazon Chime SDK meetings (multi-party SFU).
 *
 * POST   /calls                  — start a call (JWT required). Registers a call
 *                                  record and returns { callId, hostToken }.
 * GET    /calls/{callId}/join    — public. Creates a Chime attendee (and the
 *                                  meeting itself, lazily) and returns the
 *                                  Meeting + Attendee objects the browser SDK
 *                                  needs. The attendee join token is the only
 *                                  credential the client ever holds.
 * DELETE /calls/{callId}         — end the call for everyone (hostToken required).
 *
 * The Chime meeting is created lazily on first join (not at POST /calls)
 * because Chime auto-terminates meetings that sit empty for ~5 minutes; the
 * call link stays valid for 24h and simply spins up a fresh meeting whenever
 * someone joins after the previous meeting expired.
 *
 * DynamoDB items (emails table):
 *   PK: CALL#<callId>   SK: CALL         — ownerId, hostTokenHash, meetingId?, ttl (24h)
 *   PK: USER#<userId>   SK: CALL#ACTIVE  — callId (so starting a new call cleans
 *                                          up the previous meeting)
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand, UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import {
  ChimeSDKMeetingsClient,
  CreateMeetingCommand,
  CreateAttendeeCommand,
  DeleteMeetingCommand,
  GetMeetingCommand,
  type Meeting,
} from '@aws-sdk/client-chime-sdk-meetings';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { ulid } from 'ulid';
import type { ApiEvent, ApiResult } from '../types';

const ddb = new DynamoDBClient({});
const chime = new ChimeSDKMeetingsClient({});
const ses = new SESClient({});

const EMAILS_TABLE = process.env.EMAILS_TABLE_NAME!;
const USERS_TABLE = process.env.USERS_TABLE_NAME!;
const REGION = process.env.AWS_REGION!;
const WEB_DOMAIN = process.env.RECIPIENT_DOMAIN!; // web app + SES-verified mail domain
const CALL_TTL_SECONDS = 24 * 60 * 60; // call links expire after 24h

function json(status: number, body: unknown): ApiResult {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function getUserId(event: ApiEvent): string | undefined {
  return event.requestContext.authorizer?.jwt?.claims?.['sub'] as string | undefined;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function tokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(sha256Hex(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

interface CallRecord {
  ownerId: string;
  hostTokenHash: string;
  meetingId?: string;
  ttl: number;
}

async function getCallRecord(callId: string): Promise<CallRecord | undefined> {
  const res = await ddb.send(new GetItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({ PK: `CALL#${callId}`, SK: 'CALL' }),
  }));
  if (!res.Item) return undefined;
  const item = unmarshall(res.Item) as CallRecord;
  // TTL deletion is lazy — treat expired records as gone
  if (item.ttl && item.ttl * 1000 < Date.now()) return undefined;
  return item;
}

/** Best-effort teardown of a call's Chime meeting + DDB records. */
async function deleteCallResources(callId: string, record: Pick<CallRecord, 'ownerId' | 'meetingId'>): Promise<void> {
  if (record.meetingId) {
    await chime.send(new DeleteMeetingCommand({ MeetingId: record.meetingId }))
      .catch(err => console.warn(`[calls] Failed to delete meeting ${record.meetingId}:`, err));
  }
  await ddb.send(new DeleteItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({ PK: `CALL#${callId}`, SK: 'CALL' }),
  })).catch(() => { /* best-effort */ });
  await ddb.send(new DeleteItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({ PK: `USER#${record.ownerId}`, SK: 'CALL#ACTIVE' }),
  })).catch(() => { /* best-effort */ });
}

/** Fetch the meeting if it is still running; Chime ends empty meetings after ~5 min. */
async function getLiveMeeting(meetingId: string): Promise<Meeting | undefined> {
  try {
    const res = await chime.send(new GetMeetingCommand({ MeetingId: meetingId }));
    return res.Meeting;
  } catch (err) {
    if ((err as { name?: string }).name === 'NotFoundException') return undefined;
    throw err;
  }
}

/**
 * Return the call's live meeting, creating one if none exists (first joiner,
 * or everyone left long enough ago that Chime expired the previous one).
 * A conditional DDB update resolves the race where two people join a dead
 * call simultaneously — the loser deletes its meeting and uses the winner's.
 */
async function ensureMeeting(callId: string, record: CallRecord): Promise<Meeting> {
  if (record.meetingId) {
    const existing = await getLiveMeeting(record.meetingId);
    if (existing) return existing;
  }

  const created = await chime.send(new CreateMeetingCommand({
    ClientRequestToken: randomBytes(16).toString('hex'),
    MediaRegion: REGION,
    ExternalMeetingId: callId,
  }));
  const meeting = created.Meeting!;

  try {
    await ddb.send(new UpdateItemCommand({
      TableName: EMAILS_TABLE,
      Key: marshall({ PK: `CALL#${callId}`, SK: 'CALL' }),
      UpdateExpression: 'SET meetingId = :new',
      ConditionExpression: record.meetingId
        ? 'meetingId = :prev'
        : 'attribute_not_exists(meetingId)',
      ExpressionAttributeValues: marshall(
        record.meetingId
          ? { ':new': meeting.MeetingId, ':prev': record.meetingId }
          : { ':new': meeting.MeetingId },
      ),
    }));
    return meeting;
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    // Lost the race — another joiner registered a meeting first. Use theirs.
    await chime.send(new DeleteMeetingCommand({ MeetingId: meeting.MeetingId }))
      .catch(() => { /* best-effort */ });
    const winner = await getCallRecord(callId);
    const theirs = winner?.meetingId ? await getLiveMeeting(winner.meetingId) : undefined;
    if (!theirs) throw new Error('Meeting creation raced and the winning meeting is gone; retry');
    return theirs;
  }
}

// ---------------------------------------------------------------------------
// POST /calls
// ---------------------------------------------------------------------------

export async function handleCreateCall(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  // Starting a new call replaces any previous one — tear down its meeting so
  // stale links can't share a meeting with the new call.
  const active = await ddb.send(new GetItemCommand({
    TableName: EMAILS_TABLE,
    Key: marshall({ PK: `USER#${userId}`, SK: 'CALL#ACTIVE' }),
  }));
  if (active.Item) {
    const { callId: prevCallId } = unmarshall(active.Item) as { callId: string };
    const prev = await getCallRecord(prevCallId);
    await deleteCallResources(prevCallId, { ownerId: userId, meetingId: prev?.meetingId });
  }

  const callId = ulid();
  const hostToken = randomBytes(32).toString('base64url');
  const ttl = Math.floor(Date.now() / 1000) + CALL_TTL_SECONDS;

  await ddb.send(new PutItemCommand({
    TableName: EMAILS_TABLE,
    Item: marshall({
      PK: `CALL#${callId}`,
      SK: 'CALL',
      ownerId: userId,
      hostTokenHash: sha256Hex(hostToken),
      createdAt: new Date().toISOString(),
      ttl,
    }),
  }));
  await ddb.send(new PutItemCommand({
    TableName: EMAILS_TABLE,
    Item: marshall({
      PK: `USER#${userId}`,
      SK: 'CALL#ACTIVE',
      callId,
      ttl,
    }),
  }));

  return json(200, { callId, hostToken });
}

// ---------------------------------------------------------------------------
// GET /calls/{callId}/join   (public)
// ---------------------------------------------------------------------------

export async function handleJoinCall(event: ApiEvent): Promise<ApiResult> {
  const callId = event.pathParameters?.['callId'];
  if (!callId || !/^[0-9A-Za-z]{1,64}$/.test(callId)) return json(400, { error: 'Invalid call ID' });

  const record = await getCallRecord(callId);
  if (!record) return json(404, { error: 'Call not found or ended' });

  const hostToken = event.queryStringParameters?.['hostToken'];
  const isHost = !!hostToken && tokenMatches(hostToken, record.hostTokenHash);

  // Display name chosen in the lobby, carried on the Chime ExternalUserId as
  // "host|Name" / "guest|Name" so every participant sees it (tile labels, chat).
  const rawName = (event.queryStringParameters?.['name'] ?? '').replace(/[|\p{C}]/gu, '').trim().slice(0, 40);
  const name = rawName || (isHost ? 'Host' : 'Guest');

  const meeting = await ensureMeeting(callId, record);

  const attendee = await chime.send(new CreateAttendeeCommand({
    MeetingId: meeting.MeetingId,
    // Suffix keeps ExternalUserId unique even when two guests pick the same name
    ExternalUserId: `${isHost ? 'host' : 'guest'}|${name}|${randomBytes(4).toString('base64url')}`,
  }));

  return json(200, {
    role: isHost ? 'HOST' : 'GUEST',
    meeting,
    attendee: attendee.Attendee,
  });
}

// ---------------------------------------------------------------------------
// DELETE /calls/{callId}   (public, hostToken required)
// ---------------------------------------------------------------------------

export async function handleEndCall(event: ApiEvent): Promise<ApiResult> {
  const callId = event.pathParameters?.['callId'];
  if (!callId || !/^[0-9A-Za-z]{1,64}$/.test(callId)) return json(400, { error: 'Invalid call ID' });

  const record = await getCallRecord(callId);
  if (!record) return json(404, { error: 'Call not found or ended' });

  const hostToken = event.queryStringParameters?.['hostToken'];
  if (!hostToken || !tokenMatches(hostToken, record.hostTokenHash)) {
    return json(403, { error: 'Only the host can end the call' });
  }

  await deleteCallResources(callId, record);
  return { statusCode: 204 };
}

// ---------------------------------------------------------------------------
// POST /calls/schedule   — schedule a meeting for later and email invites
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** iCalendar UTC timestamp: 20260801T150000Z */
function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Escape a value for an iCalendar text field (RFC 5545 §3.3.11). */
function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Fold a content line to ≤75 octets with CRLF + space continuation (RFC 5545 §3.1). */
function foldIcsLine(line: string): string {
  if (line.length <= 75) return line;
  const out = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) out.push(' ' + line.slice(i, i + 74));
  return out.join('\r\n');
}

function buildInviteIcs(opts: {
  callId: string;
  title: string;
  start: Date;
  end: Date;
  notes: string;
  organizerName: string;
  organizerEmail: string;
  attendees: string[];
  joinUrl: string;
}): string {
  const { callId, title, start, end, notes, organizerName, organizerEmail, attendees, joinUrl } = opts;
  const description = notes
    ? `${notes}\n\nJoin the call: ${joinUrl}`
    : `Join the call: ${joinUrl}`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//WilsonHQ//Chase Email//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${callId}@${WEB_DOMAIN}`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(title)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    `LOCATION:${icsEscape(joinUrl)}`,
    `URL:${icsEscape(joinUrl)}`,
    `ORGANIZER;CN=${icsEscape(organizerName)}:mailto:${organizerEmail}`,
    // Organizer also appears as an accepted attendee so the event shows on their calendar.
    `ATTENDEE;CN=${icsEscape(organizerName)};ROLE=CHAIR;PARTSTAT=ACCEPTED:mailto:${organizerEmail}`,
    ...attendees.map(a =>
      `ATTENDEE;CN=${a};ROLE=REQ-PARTICIPANT;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:${a}`,
    ),
    'SEQUENCE:0',
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldIcsLine).join('\r\n');
}

/**
 * Build a MIME message carrying the invite. The .ics is included both as a
 * text/calendar alternative part (Gmail renders it as an invite) and as an
 * attachment (Apple Mail / Outlook add it to the calendar).
 */
function buildInviteMime(opts: {
  from: string;
  to: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  ics: string;
}): string {
  const { from, to, subject, textBody, htmlBody, ics } = opts;
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  const icsB64 = b64(ics);
  const mixed = `----=_mix_${Date.now()}`;
  const alt = `----=_alt_${Date.now() + 1}`;

  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '',
    b64(textBody), '',
    `--${alt}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '',
    b64(htmlBody), '',
    `--${alt}`,
    'Content-Type: text/calendar; charset=UTF-8; method=REQUEST',
    'Content-Transfer-Encoding: base64', '',
    icsB64, '',
    `--${alt}--`,
    '',
    `--${mixed}`,
    'Content-Type: application/ics; name="invite.ics"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="invite.ics"', '',
    icsB64, '',
    `--${mixed}--`,
  ].join('\r\n');
}

export async function handleScheduleCall(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) return json(401, { error: 'Unauthorized' });

  let body: { title?: string; startsAt?: string; durationMinutes?: number; attendees?: string[]; notes?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const title = (body.title ?? '').toString().trim().slice(0, 200);
  if (!title) return json(400, { error: 'A meeting title is required' });

  const start = new Date(body.startsAt ?? '');
  if (Number.isNaN(start.getTime())) return json(400, { error: 'Invalid start date/time' });
  if (start.getTime() < Date.now() - 60_000) return json(400, { error: 'Start time must be in the future' });

  const durRaw = Number(body.durationMinutes);
  const durationMinutes = Number.isFinite(durRaw) && durRaw > 0 ? Math.min(durRaw, 24 * 60) : 30;
  const end = new Date(start.getTime() + durationMinutes * 60_000);

  const attendees = Array.from(new Set(
    (Array.isArray(body.attendees) ? body.attendees : [])
      .map(a => String(a).trim().toLowerCase())
      .filter(a => EMAIL_RE.test(a)),
  )).slice(0, 50);
  if (attendees.length === 0) return json(400, { error: 'At least one valid attendee email is required' });

  const notes = (body.notes ?? '').toString().slice(0, 5000);

  // Organizer identity (the From address must be a verified domain mailbox).
  const userRes = await ddb.send(new GetItemCommand({
    TableName: USERS_TABLE,
    Key: marshall({ userId }),
    ProjectionExpression: 'email, username',
  }));
  if (!userRes.Item) return json(404, { error: 'User not found' });
  const { email: organizerEmail, username } = unmarshall(userRes.Item) as { email: string; username?: string };
  const organizerName = username || organizerEmail.split('@')[0];

  // Durable call record — TTL a few hours past the meeting end. Deliberately
  // does NOT touch USER#<userId> CALL#ACTIVE, so scheduling never disturbs a
  // call the user might currently be hosting.
  const callId = ulid();
  const hostToken = randomBytes(32).toString('base64url');
  const ttl = Math.floor(end.getTime() / 1000) + 6 * 60 * 60;

  await ddb.send(new PutItemCommand({
    TableName: EMAILS_TABLE,
    Item: marshall({
      PK: `CALL#${callId}`,
      SK: 'CALL',
      ownerId: userId,
      hostTokenHash: sha256Hex(hostToken),
      title,
      scheduledStart: start.toISOString(),
      scheduledEnd: end.toISOString(),
      createdAt: new Date().toISOString(),
      ttl,
    }),
  }));

  const joinUrl = `https://${WEB_DOMAIN}/call/${callId}`;
  const hostUrl = `${joinUrl}#ht=${hostToken}`;

  const ics = buildInviteIcs({
    callId, title, start, end, notes, organizerName, organizerEmail, attendees, joinUrl,
  });

  const whenText = start.toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'full', timeStyle: 'short' }) + ' UTC';
  const textBody = [
    `You're invited to: ${title}`,
    ``,
    `When: ${whenText} (${durationMinutes} min)`,
    `Join the call: ${joinUrl}`,
    ...(notes ? ['', notes] : []),
  ].join('\n');
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const htmlBody = [
    `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#111">`,
    `<h2 style="margin:0 0 8px">${esc(title)}</h2>`,
    `<p style="margin:0 0 4px"><b>When:</b> ${esc(whenText)} (${durationMinutes} min)</p>`,
    `<p style="margin:12px 0"><a href="${esc(joinUrl)}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Join the call</a></p>`,
    notes ? `<p style="white-space:pre-wrap;margin:12px 0;color:#374151">${esc(notes)}</p>` : '',
    `<p style="margin:12px 0 0;color:#6b7280;font-size:13px">Link: <a href="${esc(joinUrl)}">${esc(joinUrl)}</a></p>`,
    `</div>`,
  ].join('');

  const mime = buildInviteMime({
    from: `${organizerName} <${organizerEmail}>`,
    // Send to attendees and the organizer, so it lands on everyone's calendar.
    to: [organizerEmail, ...attendees].join(', '),
    subject: `Invitation: ${title}`,
    textBody,
    htmlBody,
    ics,
  });

  try {
    await ses.send(new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(mime, 'utf8') } }));
  } catch (err) {
    console.error('[calls] Failed to send meeting invite:', err);
    // The call was created; report the failure so the client can surface it.
    return json(502, { error: 'Meeting created but the invite email failed to send', callId, hostUrl });
  }

  return json(200, {
    callId,
    hostToken,
    hostUrl,
    joinUrl,
    scheduledStart: start.toISOString(),
    scheduledEnd: end.toISOString(),
    invited: attendees,
  });
}
