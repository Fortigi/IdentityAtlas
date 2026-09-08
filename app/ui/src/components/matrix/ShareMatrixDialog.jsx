// Create-a-share dialog (#1166): name the view, mint the link, copy it.
//
// Two states in one modal — the form, then the link. The link is shown once:
// only the token's hash is stored, so if the sharer closes the dialog without
// copying it they have to create a new share. The copy step therefore uses
// CopyButton, which reports whether the clipboard write actually succeeded.

import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { Modal, Field, ErrorBox, PrimaryButton, SecondaryButton } from '@ui/components/contexts/ModalPrimitives';
import CopyButton from '@ui/components/CopyButton';
import { displayModeOf } from '@ui/components/shared/sharedSnapshot';
// The token rides in the URL fragment, which browsers never send to a server —
// so it can't land in a proxy or access log. buildShareUrl owns that shape.
import { buildShareUrl } from '@ui/App.helpers';

export default function ShareMatrixDialog({ filter, managed, onClose }) {
  const { authFetch } = useAuth();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [token, setToken] = useState(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch('/api/matrix/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          filter,
          managed: managed || 'all',
          displayMode: displayModeOf(filter),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Could not create the share (HTTP ${res.status})`);
      setToken(body.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (token) {
    const url = buildShareUrl(token);
    return (
      <Modal title="Share link created" subtitle={name.trim()} onClose={onClose} width={560} dismissOnBackdrop={false}>
        <p className="text-xs text-gray-600 dark:text-gray-400">
          Send this link to your colleague. They sign in with their normal Microsoft account —
          no Identity Atlas role needed — and see this matrix, read-only. The link is shown
          once; you can revoke it later from Shared matrices.
        </p>
        <p className="mt-3 break-all rounded border border-gray-200 bg-gray-50 p-2 font-mono text-[11px] text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
          {url}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <CopyButton text={url} label="Copy link" copiedLabel="Link copied" />
          <SecondaryButton onClick={onClose}>Done</SecondaryButton>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Share this matrix" onClose={onClose} width={520} dismissOnBackdrop={false}>
      <p className="mb-3 text-xs text-gray-600 dark:text-gray-400">
        Creates a link to the matrix exactly as it looks now. Later changes to the saved
        filter won&apos;t affect it — but the access data behind it stays up to date.
      </p>
      <Field label="Name this view" help="Shown to the recipient and on the Shared matrices page.">
        <input
          id="share-matrix-name"
          type="text"
          // ModalPrimitives' Field renders a bare <label>, so the accessible
          // name has to come from the control itself.
          aria-label="Name this view"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Sales team access"
          className="mt-1 w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"
        />
      </Field>
      <ErrorBox message={error} />
      <div className="mt-4 flex justify-end gap-2">
        <SecondaryButton onClick={onClose} disabled={busy}>Cancel</SecondaryButton>
        <PrimaryButton onClick={create} disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create link'}
        </PrimaryButton>
      </div>
    </Modal>
  );
}
