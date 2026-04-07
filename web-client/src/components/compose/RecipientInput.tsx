/**
 * RecipientInput — token-based address field with contact autocomplete.
 *
 * - Each confirmed recipient is rendered as a removable chip.
 * - Typing in the text input queries the local contacts DB and shows a
 *   dropdown of fuzzy-matched name/address pairs.
 * - A recipient is committed on: Enter, Tab, comma, or clicking a suggestion.
 * - Backspace on an empty input removes the last chip.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { getDb } from '../../db/Database';

export interface Contact {
  address: string;
  name: string;
}

interface Props {
  label: string;
  recipients: string[];                    // array of "Name <addr>" or "addr" strings
  onChange: (recipients: string[]) => void;
  autoFocus?: boolean;
}

// ---------------------------------------------------------------------------
// DB search
// ---------------------------------------------------------------------------

async function searchContacts(query: string): Promise<Contact[]> {
  if (!query.trim()) return [];
  const db = await getDb();
  const q = `%${query.toLowerCase()}%`;
  const rows = await db.selectObjects(
    `SELECT address, name FROM contacts
       WHERE lower(address) LIKE ? OR lower(name) LIKE ?
       ORDER BY frequency DESC, lastSeen DESC
       LIMIT 8`,
    [q, q],
  );
  return rows as unknown as Contact[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a contact as a display string. */
function formatContact(c: Contact): string {
  return c.name ? `${c.name} <${c.address}>` : c.address;
}

/** Extract just the email address from a "Name <addr>" or plain "addr" string. */
export function extractAddress(s: string): string {
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RecipientInput({ label, recipients, onChange, autoFocus }: Props) {
  const [inputValue, setInputValue] = useState('');
  const [suggestions, setSuggestions] = useState<Contact[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Search contacts whenever the user types
  useEffect(() => {
    let cancelled = false;
    if (!inputValue.trim()) {
      setSuggestions([]);
      setActiveIdx(-1);
      return;
    }
    searchContacts(inputValue).then(results => {
      if (!cancelled) {
        setSuggestions(results);
        setActiveIdx(-1);
      }
    }).catch(() => { });
    return () => { cancelled = true; };
  }, [inputValue]);

  // Close dropdown on outside click
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current && !inputRef.current.contains(e.target as Node)
      ) {
        setSuggestions([]);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  const commitValue = useCallback((raw: string) => {
    const trimmed = raw.trim().replace(/,$/, '').trim();
    if (!trimmed) return;
    onChange([...recipients, trimmed]);
    setInputValue('');
    setSuggestions([]);
    setActiveIdx(-1);
  }, [recipients, onChange]);

  const commitContact = useCallback((c: Contact) => {
    commitValue(formatContact(c));
    inputRef.current?.focus();
  }, [commitValue]);

  const removeRecipient = useCallback((idx: number) => {
    onChange(recipients.filter((_, i) => i !== idx));
  }, [recipients, onChange]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, -1));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (activeIdx >= 0 && suggestions[activeIdx]) {
        e.preventDefault();
        commitContact(suggestions[activeIdx]!);
      } else if (e.key === 'Tab' && suggestions.length > 0) {
        e.preventDefault();
        commitContact(suggestions[0]!);
      } else if (inputValue.trim()) {
        e.preventDefault();
        commitValue(inputValue);
      }
    } else if (e.key === ',') {
      e.preventDefault();
      commitValue(inputValue);
    } else if (e.key === 'Backspace' && !inputValue && recipients.length > 0) {
      onChange(recipients.slice(0, -1));
    } else if (e.key === 'Escape') {
      setSuggestions([]);
      setActiveIdx(-1);
    }
  }

  return (
    <div className="relative flex flex-wrap items-center gap-1 px-3 py-1.5 min-h-[34px]">
      {/* Label */}
      <span className="text-xs font-medium text-gray-400 w-10 shrink-0">{label}</span>

      {/* Chips */}
      {recipients.map((r, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs
                     bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200
                     max-w-[220px]"
        >
          <span className="truncate" title={r}>{r}</span>
          <button
            type="button"
            onMouseDown={e => { e.preventDefault(); removeRecipient(i); }}
            className="shrink-0 text-blue-500 hover:text-blue-800 dark:hover:text-blue-100
                       leading-none"
            aria-label={`Remove ${r}`}
          >
            ×
          </button>
        </span>
      ))}

      {/* Text input */}
      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        autoFocus={autoFocus}
        onChange={e => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          // Small delay so suggestion clicks register before blur fires
          setTimeout(() => {
            if (inputValue.trim()) commitValue(inputValue);
            setSuggestions([]);
          }, 150);
        }}
        placeholder={recipients.length === 0 ? 'Recipients' : ''}
        className="flex-1 min-w-[120px] py-0.5 bg-transparent focus:outline-none text-sm"
        aria-autocomplete="list"
        aria-expanded={suggestions.length > 0}
      />

      {/* Suggestions dropdown */}
      {suggestions.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute left-0 top-full mt-1 z-50 w-full max-w-sm
                     bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
                     rounded-lg shadow-lg overflow-hidden"
        >
          {suggestions.map((c, i) => (
            <button
              key={c.address}
              type="button"
              onMouseDown={e => { e.preventDefault(); commitContact(c); }}
              className={`w-full flex flex-col items-start px-3 py-2 text-sm text-left
                text-gray-900 dark:text-gray-100 transition-colors
                ${i === activeIdx
                  ? 'bg-blue-50 dark:bg-blue-900/40'
                  : 'hover:bg-gray-50 dark:hover:bg-gray-700/60'}`}
            >
              {c.name
                ? <><span className="font-medium truncate">{c.name}</span>
                  <span className="text-xs text-gray-500 dark:text-gray-400 truncate">{c.address}</span></>
                : <span className="truncate">{c.address}</span>
              }
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
