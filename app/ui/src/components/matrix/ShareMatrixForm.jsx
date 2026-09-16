// The body of "share this matrix": pick who it is for, and share it (#1166,
// reworked by #1202).
//
// Hosted by SharePanel (the matrix bar's share dialog and Admin). The wizard's
// Save & share step does not host the form — its one primary button saves and
// then shares — but it builds the same request (shareRequestBody), sends it the
// same way (sendJson) and picks people with the same field (SharePeopleField),
// so the two paths cannot drift.
//
// ONE name, never two. A matrix that is already saved is shared under its own
// name and is not asked for another; an unsaved one is saved and shared in a
// single act, under the single name given here. A name that is taken comes
// back as a 409 and is shown inline — nothing is ever overwritten.
//
// A share is addressed to PEOPLE. Without at least one recipient there is
// nothing to create — the button stays disabled — because a link that anyone
// who receives it can open is exactly what this replaced.

import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { Field, ErrorBox, PrimaryButton } from '@ui/components/contexts/ModalPrimitives';
import CopyButton from '@ui/components/CopyButton';
import PeoplePicker from '@ui/components/inputs/PeoplePicker';
import { shareRequestBody } from './shareState';
import { sendJson } from './matrixRequests';
// The share address rides in the URL fragment, which browsers never send to a
// server — so it can't land in a proxy or access log. buildShareUrl owns that
// shape.
import { buildShareUrl } from '@ui/App.helpers';

// Rendered once the share exists: the link and who it now opens for. Unlike
// #1166's one-time token, this link can be copied again later — from the matrix
// bar, the wizard or Admin — so nothing here has to warn about losing it.
function CreatedShare({ url, recipients }) {
  return (
    <div>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        Send this link to {recipients.length === 1 ? 'them' : 'them all'}. Only the {recipients.length}{' '}
        {recipients.length === 1 ? 'person' : 'people'} you picked can open it — they sign in with their
        normal Microsoft account, no Identity Atlas role needed, and see this matrix read-only.
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
        <CopyButton text={url} label="Copy share link" copiedLabel="Share link copied" />
      </div>
    </div>
  );
}

// "Share with": the people a new share is addressed to. One component so the
// wizard's Save & share step picks recipients with exactly the field this form
// uses — same label, same promise about who can open the link.
export function SharePeopleField({ value, onChange }) {
  return (
    <PeoplePicker
      value={value}
      onChange={onChange}
      inputId="share-matrix-people"
      label="Share with"
      help="Only these people can open the link. Anyone else it reaches is turned away."
    />
  );
}

export default function ShareMatrixForm({ filter, managed, savedFilterId = null, savedName = null, onCreated }) {
  const { authFetch } = useAuth();
  const [name, setName] = useState('');
  const [people, setPeople] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);
  // Already saved → the matrix has a name, and asking for a second one is the
  // exact complaint #1202 was filed about.
  const alreadySaved = !!savedFilterId;

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const body = await sendJson(authFetch, '/api/matrix/shares', {
        body: shareRequestBody({ savedFilterId, name, filter, managed, recipients: people }),
        fallback: 'Could not share this matrix',
      });
      setCreated({ url: buildShareUrl(body.shareAddress || body.id), recipients: body.recipients || people });
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
        {alreadySaved
          ? `Shares the saved matrix “${savedName}” with the people you name below. They always see it as it stands — later changes to it reach them too.`
          : 'Saves this matrix under the name you give it and shares it with the people you name below. They always see it as it stands — later changes to it reach them too.'}
      </p>
      {!alreadySaved && (
        <Field label="Name this matrix" help="Saved org-wide under this name, and shown to the recipients.">
          <input
            id="share-matrix-name"
            type="text"
            // ModalPrimitives' Field renders a bare <label>, so the accessible
            // name has to come from the control itself.
            aria-label="Name this matrix"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Sales team access"
            className="mt-1 w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"
          />
        </Field>
      )}
      <SharePeopleField value={people} onChange={setPeople} />
      <ErrorBox message={error} />
      <div className="flex justify-end">
        <PrimaryButton onClick={create} disabled={busy || (!alreadySaved && !name.trim()) || people.length === 0}>
          {busy ? 'Sharing…' : (alreadySaved ? 'Share matrix' : 'Save & share')}
        </PrimaryButton>
      </div>
    </div>
  );
}
