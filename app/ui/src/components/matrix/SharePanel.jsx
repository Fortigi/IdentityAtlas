// Manage a saved matrix's share, in place (#1202).
//
// The answer to "a shared matrix exists that I can't find or manage from the
// matrix itself": one panel that shows who a matrix is shared with and lets the
// author add or remove people, copy the link again, or stop sharing — hosted
// identically by the matrix bar, the wizard's Save/Share step and Admin, so
// there is exactly one place those actions are implemented.
//
// Changing recipients keeps the same link: the addressed-to gate reads the
// recipient list live and fails closed, so somebody removed here loses access
// on their next request without anything being re-minted. Stopping sharing
// revokes the link but keeps the saved matrix; sharing again issues a new link.

import { useCallback, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useDialog } from '@ui/components/dialogContext';
import CopyButton from '@ui/components/CopyButton';
import PeoplePicker from '@ui/components/inputs/PeoplePicker';
import { ErrorBox, SecondaryButton } from '@ui/components/contexts/ModalPrimitives';
import { buildShareUrl } from '@ui/App.helpers';
import ShareMatrixForm from './ShareMatrixForm';
import { sendJson } from './matrixRequests';
import { useRecipientAutosave, autosaveNotice } from './useRecipientAutosave';
import { activeShareOf, sharedWithLabel } from './shareState';

// The editing half: the current recipients, changed and SAVED AS THEY CHANGE.
//
// There is no Save button here any more. Adding somebody on this panel used to
// leave them without access until a second, easily-missed click — while the
// list on screen already showed them as a recipient. useRecipientAutosave owns
// the writing; this renders the people, the link and the way out.
export function ShareRecipientEditor({ share, onChanged }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const [busy, setBusy] = useState(false);
  const [stopError, setStopError] = useState(null);
  const url = buildShareUrl(share.id);

  const save = useCallback((people) => sendJson(authFetch, `/api/matrix/shares/${share.id}/recipients`, {
    method: 'PUT',
    body: { recipients: people },
    fallback: 'Could not update the people this is shared with',
  }), [authFetch, share.id]);

  const { people, setPeople, status, error } = useRecipientAutosave({
    initial: (share.recipients || []).map(r => ({
      principalId: r.principalId || null,
      userKey: r.userKey,
      displayName: r.displayName || r.userKey,
    })),
    save,
    onSaved: onChanged,
  });
  const notice = autosaveNotice(status);

  async function stopSharing() {
    const ok = await dialog.confirm({
      title: 'Stop sharing this matrix?',
      message: `The link stops working for everyone who has it. The saved matrix “${share.name}” stays, and you can share it again later — that issues a new link.`,
      confirmLabel: 'Stop sharing',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await authFetch(`/api/matrix/shares/${share.id}/revoke`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      dialog.toast('Sharing stopped', { variant: 'success' });
      onChanged?.();
    } catch {
      setStopError('Could not stop sharing. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-600 dark:text-gray-400">
        {sharedWithLabel(share.recipients?.length || 0)}. They see this matrix as it stands — saving a
        change to it changes what they see.
      </p>
      <PeoplePicker
        value={people}
        onChange={setPeople}
        inputId={`share-recipients-${share.id}`}
        label="Shared with"
        help="Changes are saved on their own. Removing somebody takes their access away immediately, and the link itself stays the same."
      />
      {notice && (
        <p
          role="status"
          className={notice.tone === 'warn'
            ? 'text-[11px] text-amber-700 dark:text-amber-300'
            : 'text-[11px] text-gray-600 dark:text-gray-400'}
        >
          {notice.text}
        </p>
      )}
      <p className="break-all rounded border border-gray-200 bg-gray-50 p-2 font-mono text-[11px] text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
        {url}
      </p>
      <ErrorBox message={error || stopError} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={stopSharing}
          disabled={busy}
          className="rounded border border-red-200 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/30"
        >
          Stop sharing
        </button>
        <CopyButton text={url} label="Copy share link" copiedLabel="Share link copied" />
      </div>
    </div>
  );
}

// The whole panel: manage the live share if there is one, otherwise offer to
// create it. `share` can be supplied by a host that already has the row (Admin);
// everything else lets the panel look it up by saved matrix.
export default function SharePanel({ savedFilterId, savedName, filter, managed, share: given, onChanged, onClose }) {
  const { authFetch } = useAuth();
  const { data: shares, loading, reload } = useFetch('/api/matrix/shares', {
    authFetch,
    enabled: !given && !!savedFilterId,
    initialData: [],
    transform: rows => (Array.isArray(rows) ? rows : []),
  });

  const changed = useCallback(() => { if (!given) reload(); onChanged?.(); }, [given, reload, onChanged]);
  const share = given || activeShareOf(shares, savedFilterId);

  if (!given && loading) {
    return <p className="text-xs text-gray-600 dark:text-gray-400">Loading sharing…</p>;
  }

  return (
    <div className="space-y-3">
      {share
        ? <ShareRecipientEditor key={share.id} share={share} onChanged={changed} />
        : (
          <ShareMatrixForm
            filter={filter}
            managed={managed}
            savedFilterId={savedFilterId}
            savedName={savedName}
            onCreated={changed}
          />
        )}
      {onClose && (
        <div className="flex justify-end">
          <SecondaryButton onClick={onClose}>Done</SecondaryButton>
        </div>
      )}
    </div>
  );
}
