import { useEffect, useRef } from 'react';
import { useUiStore } from '../store/uiStore';

/**
 * Makes the Android/browser back gesture close an open email (returning to the
 * list) instead of leaving the app.
 *
 * Opening an email pushes a history entry; a back navigation pops it and
 * deselects the email. Closing the email via the in-app back button keeps
 * history in sync by popping the entry we added.
 *
 * Scoped to mobile widths (< md breakpoint) — on desktop the list and message
 * are shown side by side, so there's nothing to "go back" from. History entries
 * are only ever pushed on mobile, so on desktop this hook is effectively inert.
 */
export function useEmailBackGesture() {
  const selectedEmailUlid = useUiStore(s => s.selectedEmailUlid);
  const wasOpenRef = useRef(false);

  // A back navigation while an email is open should close it.
  useEffect(() => {
    const onPopState = () => {
      if (useUiStore.getState().selectedEmailUlid) {
        useUiStore.getState().selectEmail(null);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Keep a history entry in sync with the open/closed state.
  useEffect(() => {
    const isOpen = selectedEmailUlid !== null;
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = isOpen;

    if (isOpen && !wasOpen) {
      // Email just opened — on mobile, push an entry so the back gesture closes it.
      if (window.matchMedia('(max-width: 767px)').matches) {
        history.pushState({ chaseEmailOpen: true }, '');
      }
    } else if (!isOpen && wasOpen) {
      // Email just closed. If it closed via the in-app back button our pushed
      // entry is still on top — pop it so history stays balanced. If it closed
      // via a back navigation, the browser already popped it (marker is gone),
      // so we skip to avoid a double-back.
      if (history.state?.chaseEmailOpen) history.back();
    }
  }, [selectedEmailUlid]);
}
