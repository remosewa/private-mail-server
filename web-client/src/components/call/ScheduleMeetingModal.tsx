import { useState } from 'react';
import { scheduleCall, type ScheduleMeetingResponse } from '../../api/calls';

interface Props {
  onClose: () => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Default the start to the next full hour, formatted for <input type="datetime-local">. */
function defaultStartLocal(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  // Format as local YYYY-MM-DDTHH:mm (datetime-local has no timezone).
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ScheduleMeetingModal({ onClose }: Props) {
  const [title, setTitle] = useState('');
  const [startLocal, setStartLocal] = useState(defaultStartLocal);
  const [duration, setDuration] = useState(30);
  const [attendeesText, setAttendeesText] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ScheduleMeetingResponse | null>(null);
  const [copied, setCopied] = useState(false);

  // Split on commas / whitespace / newlines into candidate addresses.
  const attendees = attendeesText.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  const invalid = attendees.filter(a => !EMAIL_RE.test(a));
  const canSubmit =
    title.trim().length > 0 &&
    !!startLocal &&
    attendees.length > 0 &&
    invalid.length === 0 &&
    !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      // datetime-local is in the user's local time; convert to ISO/UTC.
      const startsAt = new Date(startLocal).toISOString();
      const res = await scheduleCall({
        title: title.trim(),
        startsAt,
        durationMinutes: duration,
        attendees,
        notes: notes.trim() || undefined,
      });
      setResult(res);
    } catch (err) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        'Failed to schedule the meeting. Please try again.';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  function copyHostLink() {
    if (!result) return;
    void navigator.clipboard.writeText(result.hostUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const inputClass =
    'w-full px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 outline-none ' +
    'focus:border-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md bg-white dark:bg-gray-900 rounded-xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {result ? 'Meeting scheduled' : 'Schedule a meeting'}
          </h2>
          <button onClick={onClose} aria-label="Close" className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {result ? (
          <div className="p-5 flex flex-col gap-4 overflow-y-auto">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Calendar invites were emailed to {result.invited.length} {result.invited.length === 1 ? 'person' : 'people'} and yourself.
              Everyone gets a link to join at the scheduled time.
            </p>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Your host link (keep this — it lets you start & control the call)</span>
              <div className="flex items-center gap-2">
                <input readOnly value={result.hostUrl} className={inputClass + ' flex-1 text-xs'} onFocus={e => e.currentTarget.select()} />
                <button
                  onClick={copyHostLink}
                  className="shrink-0 px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
            <button
              onClick={onClose}
              className="mt-1 w-full py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-lg font-medium
                         dark:bg-gray-800 dark:hover:bg-gray-700 dark:text-gray-100 transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="p-5 flex flex-col gap-3.5 overflow-y-auto">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Title</span>
              <input
                autoFocus
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="Meeting title"
                maxLength={200}
                className={inputClass}
              />
            </label>

            <div className="flex gap-3">
              <label className="flex flex-col gap-1.5 flex-1">
                <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Date &amp; time</span>
                <input
                  type="datetime-local"
                  value={startLocal}
                  onChange={e => setStartLocal(e.target.value)}
                  className={inputClass}
                />
              </label>
              <label className="flex flex-col gap-1.5 w-32">
                <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Duration</span>
                <select value={duration} onChange={e => setDuration(Number(e.target.value))} className={inputClass}>
                  <option value={15}>15 min</option>
                  <option value={30}>30 min</option>
                  <option value={45}>45 min</option>
                  <option value={60}>1 hour</option>
                  <option value={90}>1.5 hours</option>
                  <option value={120}>2 hours</option>
                </select>
              </label>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Attendees</span>
              <textarea
                value={attendeesText}
                onChange={e => setAttendeesText(e.target.value)}
                placeholder="Email addresses, separated by commas or spaces"
                rows={2}
                className={inputClass + ' resize-none'}
              />
              {invalid.length > 0 && (
                <span className="text-xs text-red-500">Not a valid email: {invalid.join(', ')}</span>
              )}
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Notes (optional)</span>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Agenda, details…"
                rows={2}
                className={inputClass + ' resize-none'}
              />
            </label>

            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

            <button
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
              className="mt-1 w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed
                         text-white font-medium rounded-lg transition-colors"
            >
              {submitting ? 'Scheduling…' : 'Schedule & send invites'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
