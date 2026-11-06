import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { PersonSearch } from '@ui/components/contexts/ContextRoleModal';
import { Modal, ErrorBox, PrimaryButton, SecondaryButton } from '@ui/components/contexts/ModalPrimitives';

// ─── Add information about a unit or an application ──────────────────────
// Anything that says something about it: a transcript, notes, an Excel or CSV
// list, a Word document — as a file, or pasted. Who it is from is optional (an
// interview has someone; a list or a document may not — then the source is the
// file and whoever added it); when is the date of the source. POST multipart to
// /api/contexts/:id/interviews (an "interview" there is any added source). The
// answer says whether a model reads it now (llmConfigured); without one the
// analyst adds claims by hand from the Sources list. Nothing changes the unit
// until someone reviews what it says.

export const ACCEPT = '.txt,.md,.docx,.vtt,.srt,.csv,.xlsx';
export const INTRO = 'A transcript, notes, an Excel or CSV list, a Word document — anything that says something about this unit.';
const today = () => new Date().toISOString().slice(0, 10);

const TAB = 'rounded px-2.5 py-1 text-xs font-medium';
const TAB_ON = 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900';
const TAB_OFF = 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600';
const INPUT = 'mt-1 w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';

function WhoFrom({ person, onPick, onClear }) {
  if (!person) return <PersonSearch inputId="source-person-search" label="Who is this from? (optional)" onPick={onPick} />;
  return (
    <p className="text-gray-700 dark:text-gray-300">
      From: <span className="font-medium text-gray-900 dark:text-white">{person.displayName}</span>{' '}
      <button type="button" onClick={onClear} className="text-blue-700 underline dark:text-blue-300">change</button>
    </p>
  );
}

export default function AddInformationModal({ contextId, onAdded, onClose }) {
  const { authFetch } = useAuth();
  const [mode, setMode] = useState('file');
  const [file, setFile] = useState(null);
  const [text, setText] = useState('');
  const [person, setPerson] = useState(null);
  const [date, setDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ready = (mode === 'file' ? !!file : text.trim() !== '') && !!date;

  async function submit() {
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      if (mode === 'file') fd.append('file', file, file.name);
      else fd.append('text', text);
      if (person) fd.append('principalId', person.id);
      fd.append('interviewedAt', date);
      const r = await authFetch(`/api/contexts/${contextId}/interviews`, { method: 'POST', body: fd });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      onAdded(body);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add information" subtitle={INTRO} onClose={onClose} width={520} dismissOnBackdrop={false}>
      <div className="space-y-3 text-xs">
        <div role="group" aria-label="What to add" className="flex gap-1.5">
          <button type="button" aria-pressed={mode === 'file'} onClick={() => setMode('file')} className={`${TAB} ${mode === 'file' ? TAB_ON : TAB_OFF}`}>Upload a file</button>
          <button type="button" aria-pressed={mode === 'text'} onClick={() => setMode('text')} className={`${TAB} ${mode === 'text' ? TAB_ON : TAB_OFF}`}>Paste text</button>
        </div>
        {mode === 'file' ? (
          <div>
            <label htmlFor="source-file" className="block font-medium text-gray-700 dark:text-gray-300">File (.txt, .md, .docx, .vtt, .srt, .csv or .xlsx)</label>
            <input id="source-file" type="file" accept={ACCEPT} onChange={e => setFile(e.target.files?.[0] || null)}
              className="mt-1 block w-full text-xs text-gray-700 dark:text-gray-300" />
            <p className="mt-1 text-gray-600 dark:text-gray-400">A list is read one row at a time, as “Header: value; Header: value”.</p>
          </div>
        ) : (
          <div>
            <label htmlFor="source-text" className="block font-medium text-gray-700 dark:text-gray-300">Text</label>
            <textarea id="source-text" rows={8} value={text} onChange={e => setText(e.target.value)}
              placeholder="Notes, an e-mail, what someone told you…" className={INPUT} />
          </div>
        )}
        <WhoFrom person={person} onPick={setPerson} onClear={() => setPerson(null)} />
        <div>
          <label htmlFor="source-date" className="block font-medium text-gray-700 dark:text-gray-300">Date</label>
          <input id="source-date" type="date" value={date} onChange={e => setDate(e.target.value)}
            className="mt-1 rounded border border-gray-200 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200" />
        </div>
      </div>
      <ErrorBox message={error} />
      <div className="mt-3 flex justify-end gap-2">
        <SecondaryButton onClick={onClose} disabled={busy}>Cancel</SecondaryButton>
        <PrimaryButton onClick={submit} disabled={busy || !ready}>{busy ? 'Adding…' : 'Add'}</PrimaryButton>
      </div>
    </Modal>
  );
}
