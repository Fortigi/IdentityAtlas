// Shared matrices — the central overview of who shared what, with whom, and
// whether the link was ever opened (#1166).
//
// Recipients can be adjusted and the link copied from here too (#1202) — the
// row expands the same SharePanel the matrix bar and the wizard host.
//
// Lives as an Admin sub-tab: revoking somebody else's share link is an
// administrative act, not day-to-day analysis, so it sits with the other
// org-wide controls rather than in the top navigation.
//
// Org-wide by design, like saved filters: anyone with `data.share` (and so
// every Admin) sees and can revoke every share. Because a share names its
// recipients and every recipient signs in, both halves are precise — who it
// was FOR and who actually OPENED it — so "shared but never used" is
// answerable at a glance and easy to clean up.

import { useCallback, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useCanShareMatrix } from '@ui/hooks/useCanShareMatrix';
import { useDialog } from '@ui/components/dialogContext';
import EmptyState from './EmptyState';
import SharedMatrixRow from './shared/SharedMatrixRow';

export default function SharedMatricesPage() {
  const { authFetch } = useAuth();
  const canShare = useCanShareMatrix();
  const dialog = useDialog();
  const [busyId, setBusyId] = useState(null);
  // Which row has its share panel open. One at a time: two open editors on the
  // same page invite saving the wrong recipient list to the wrong share.
  const [managingId, setManagingId] = useState(null);

  const { data: shares, loading, error, reload } = useFetch('/api/matrix/shares', {
    authFetch,
    enabled: canShare,
    initialData: [],
    transform: rows => (Array.isArray(rows) ? rows : []),
  });

  const revoke = useCallback(async (share) => {
    const ok = await dialog.confirm({
      title: 'Revoke this share?',
      message: `Anyone who opens the link for "${share.name}" will see that it is no longer shared. Usage history is kept.`,
      confirmLabel: 'Revoke link',
      danger: true,
    });
    if (!ok) return;
    setBusyId(share.id);
    try {
      const res = await authFetch(`/api/matrix/shares/${share.id}/revoke`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      dialog.toast('Share revoked', { variant: 'success' });
      reload();
    } catch {
      dialog.alert('Could not revoke the share. Please try again.');
    } finally {
      setBusyId(null);
    }
  }, [authFetch, dialog, reload]);

  if (!canShare) {
    return (
      <EmptyState
        title="You don't have access to shared matrices"
        hint="Ask an administrator to grant your role the “Create matrix share links” permission."
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Every matrix shared by a link, who shared it, who it was shared with, and who has
        opened it. Use Manage to adjust who it is shared with or copy the link again; revoking
        closes the link off and keeps the saved matrix and the usage history.
      </p>

      {loading && <p className="text-sm text-gray-500 dark:text-gray-400">Loading shared matrices…</p>}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300">
          Could not load shared matrices: {error.message}
        </div>
      )}

      {!loading && !error && shares.length === 0 && (
        <EmptyState
          title="Nothing shared yet"
          hint="Open the Matrix tab and build the view you want a colleague to see. The wizard’s last step — or “Share…” in the matrix bar — saves it and turns it into a link for the people you name."
        />
      )}

      {shares.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-700/50">
              <tr className="text-left text-xs uppercase tracking-wider text-gray-600 dark:text-gray-400">
                <th scope="col" className="px-4 py-2 font-semibold">Matrix</th>
                <th scope="col" className="px-4 py-2 font-semibold">Shared by</th>
                <th scope="col" className="px-4 py-2 font-semibold">Shared with</th>
                <th scope="col" className="px-4 py-2 font-semibold">Opened by</th>
                <th scope="col" className="px-4 py-2 font-semibold">Status</th>
                <th scope="col" className="px-4 py-2 font-semibold"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {shares.map(share => (
                <SharedMatrixRow
                  key={share.id}
                  share={share}
                  busy={busyId === share.id}
                  expanded={managingId === share.id}
                  onToggle={id => setManagingId(cur => (cur === id ? null : id))}
                  onRevoke={revoke}
                  onChanged={reload}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
