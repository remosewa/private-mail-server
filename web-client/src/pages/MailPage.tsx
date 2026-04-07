import { useEffect } from 'react';
import Sidebar from '../components/layout/Sidebar';
import InboxPane from '../components/inbox/InboxPane';
import ThreadPane from '../components/thread/ThreadPane';
import ComposePane from '../components/compose/ComposeModal';
import { useUiStore } from '../store/uiStore';
import { usePushSubscription } from '../hooks/usePushSubscription';

export default function MailPage() {
  const { composeOpen, draftContext, selectedEmailUlid, mobileSidebarOpen, closeMobileSidebar } = useUiStore();
  const selectEmail = useUiStore(s => s.selectEmail);
  usePushSubscription();

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
    <div className="flex h-screen overflow-hidden bg-white dark:bg-gray-950">

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
  );
}
