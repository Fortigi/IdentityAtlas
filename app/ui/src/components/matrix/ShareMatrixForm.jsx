// The body of "share this matrix" (#1166): name it, pick who it is for, mint
// the link, copy it.
//
// One component, two hosts — the toolbar's modal (ShareMatrixDialog) and the
// wizard's final step. They differ only in the chrome around this, so the
// create call, the validation and the shown-once link live here rather than
// being written twice and drifting.
//
// A share is addressed to PEOPLE. Without at least one recipient there is
// nothing to create — the button stays disabled — because a link that anyone
// who receives it can open is exactly what this replaced.

import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { Field, ErrorBox, PrimaryButton } from '@ui/components/contexts/ModalPrimitives';
import CopyButton from '@ui/components/CopyButton';
import PeoplePicker from '@ui/components/inputs/PeoplePicker';
import { displayModeOf } from '@ui/components/shared/sharedSnapshot';
// The token rides in the URL fragment, which browsers never send to a server —
// so it can't land in a proxy or access log. buildShareUrl owns that shape.
import { buildShareUrl } from '@ui/App.helpers';

// Rendered once the share exists: the link (shown exactly once — only its hash
// was stored) and who it now opens for.
function CreatedShare({ url, recipients }) {
  return (
    <div>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        Send this link to {recipients.length === 1 ? 'them' : 'them all'}. Only the {recipients.length}{' '}
        {recipients.length === 1 ? 'person' : 'people'} you picked can open it — they sign in with their
        normal Microsoft account, no Identity Atlas role needed, and see this matrix read-only. The link
        is shown once; you can revoke it later from Admin → Shared matrices.
      </p>
      <p className="mt-3 break-all rounded border border-gray-200 bg-gray-50 p-2 font-mono text-[11px] text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
        {url}
      </p>
      <ul aria-label="Shared with" className="mt-2 flex flex-wrap gap-1.5">
        {recipients.map(r => (
          <li
            key={r.userKey}
            className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs text-blue-700 dark:border-blue-700 dark:bg-blue-900/20 dark:text-blue-300"
            title={r.userKey}
          >
            {r.displayName || r.userKey}
          </li>
        ))}
      </ul>
      <div className="mt-4">
        <CopyButton text={url} label="Copy link" copiedLabel="Link copied" />
      </div>
    </div>
  );
}

export default function ShareMatrixForm({ filter, managed, onCreated }) {
  const { authFetch } = useAuth();
  const [name, setName] = useState('');
  const [people, setPeople] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);

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
          recipients: people,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Could not create the share (HTTP ${res.status})`);
      setCreated({ url: buildShareUrl(body.token), recipients: body.recipients || people });
      onCreated?.(body);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (created) return <CreatedShare url={created.url} recipients={created.recipients} />;

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-600 dark:text-gray-400">
        Creates a link to the matrix exactly as it looks now, for the people you name below.
        Later changes to the saved filter won&apos;t affect it — but the access data behind it
        stays up to date.
      </p>
      <Field label="Name this view" help="Shown to the recipients and on the Shared matrices page.">
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
      <PeoplePicker
        value={people}
        onChange={setPeople}
        inputId="share-matrix-people"
        label="Share with"
        help="Only these people can open the link. Anyone else it reaches is turned away."
      />
      <ErrorBox message={error} />
      <div className="flex justify-end">
        <PrimaryButton onClick={create} disabled={busy || !name.trim() || people.length === 0}>
          {busy ? 'Creating…' : 'Create link'}
        </PrimaryButton>
      </div>
    </div>
  );
}
