import { useEffect, useState } from 'react';
import Sidebar from '../components/layout/Sidebar';
import InboxPane from '../components/inbox/InboxPane';
import ThreadPane from '../components/thread/ThreadPane';
import ComposePane from '../components/compose/ComposeModal';
import RecoveryKeySetupModal from '../components/RecoveryKeySetupModal';
import { useUiStore } from '../store/uiStore';
import { usePushSubscription } from '../hooks/usePushSubscription';
import { useEmailBackGesture } from '../hooks/useEmailBackGesture';
import { useAuthStore } from '../store/authStore';

export default function MailPage() {
  const { composeOpen, draftContext, selectedEmailUlid, mobileSidebarOpen, closeMobileSidebar } = useUiStore();
  const selectEmail = useUiStore(s => s.selectEmail);
  const { hasRecoveryKey, setHasRecoveryKey, userId } = useAuthStore();
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  const dismissKey = `recovery_banner_dismissed_${userId}`;
  const [recoveryBannerDismissed, setRecoveryBannerDismissed] = useState(
    () => localStorage.getItem(`recovery_banner_dismissed_${userId}`) === 'true',
  );
  const [nudgeVisible, setNudgeVisible] = useState(false);
  const setActivePage = useUiStore(s => s.setActivePage);

  function dismissBanner() {
    localStorage.setItem(dismissKey, 'true');
    setRecoveryBannerDismissed(true);
    setNudgeVisible(true);
  }
  usePushSubscription();
  useEmailBackGesture();

  // Listen for service worker messages
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'NEW_EMAIL') {
        window.dispatchEvent(new CustomEvent('inbox-refresh-requested'));
      } else if (event.data?.type === 'NOTIFICATION_CLICKED') {
        window.dispatchEvent(new CustomEvent('inbox-refresh-requested'));
        if (event.data.ulid) selectEmail(event.data.ulid);
      }
    };

    navigator.serviceWorker?.addEventListener('message', handleMessage);
    return () => {
      navigator.serviceWorker?.removeEventListener('message', handleMessage);
    };
  }, [selectEmail]);

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-white dark:bg-gray-950">

      {hasRecoveryKey === false && !recoveryBannerDismissed && (
        <div className="shrink-0 flex items-center justify-between gap-4 px-4 py-2 bg-amber-50
                        dark:bg-amber-950 border-b border-amber-200 dark:border-amber-800 text-sm">
          <span className="text-amber-800 dark:text-amber-200">
            Set up a recovery key to protect access to your mail if you forget your password.
          </span>
          <div className="shrink-0 flex items-center gap-3">
            <button onClick={dismissBanner} className="text-amber-600 dark:text-amber-400 hover:underline">
              Maybe later
            </button>
            <button onClick={() => setShowRecoveryModal(true)} className="text-amber-700 dark:text-amber-300 font-medium hover:underline">
              Set up
            </button>
          </div>
        </div>
      )}

      {hasRecoveryKey === false && nudgeVisible && (
        <div className="shrink-0 flex items-center justify-between gap-4 px-4 py-2
                        bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 text-sm">
          <span className="text-gray-500 dark:text-gray-400">
            You can set up a recovery key anytime in{' '}
            <button onClick={() => setActivePage('settings')} className="underline hover:text-gray-700 dark:hover:text-gray-200">
              Settings
            </button>
            .
          </span>
          <button onClick={() => setNudgeVisible(false)} aria-label="Dismiss" className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            ×
          </button>
        </div>
      )}

      {showRecoveryModal && (
        <RecoveryKeySetupModal
          onClose={() => setShowRecoveryModal(false)}
          onSuccess={() => { setShowRecoveryModal(false); setHasRecoveryKey(true); }}
        />
      )}

    <div className="flex flex-1 overflow-hidden">

      {/* Mobile backdrop — tap outside sidebar to close it */}
      {mobileSidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={closeMobileSidebar}
        />
      )}

      {/* Sidebar
          Mobile : fixed drawer, slides in/out from the left edge
          Desktop: normal shrink-0 flex child, always visible */}
      <div
        className={`
          shrink-0
          max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50
          max-md:transition-transform max-md:duration-300 max-md:ease-in-out
          ${mobileSidebarOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full'}
        `}
      >
        <Sidebar />
      </div>

      {/* Inbox / thread list
          Mobile : full-screen, hidden when an email is open
          Desktop: fixed w-80 column */}
      <div
        className={`
          flex flex-col overflow-hidden w-full
          md:w-80 md:shrink-0 md:border-r md:border-gray-200
          ${selectedEmailUlid ? 'hidden md:flex' : 'flex'}
        `}
      >
        <InboxPane />
      </div>

      {/* Message view
          Mobile : full-screen, hidden when no email is selected
          Desktop: always visible flex-1 */}
      <div
        className={`
          flex flex-col overflow-hidden min-w-0 w-full
          md:flex md:flex-1
          ${selectedEmailUlid ? 'flex' : 'hidden md:flex'}
        `}
      >
        <ThreadPane />
      </div>

      {/* Compose — floating popup overlay */}
      {composeOpen && <ComposePane key={draftContext?.ulid ?? 'new'} />}
    </div>
    </div>
  );
}
