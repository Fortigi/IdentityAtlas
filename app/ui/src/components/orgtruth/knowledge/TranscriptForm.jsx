// "Add transcript": a file (.txt/.md/.srt/.vtt) or pasted text, plus the
// metadata the reviewer will want later. POST /api/org-truth/knowledge/sources —
// multipart when a file is chosen, JSON otherwise. The same text uploaded twice
// answers 200 + duplicate: the existing transcript opens instead.
//
// Props: { onAdded(row), onCancel() }
import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useDialog } from '@ui/components/dialogContext';
import { sendForm, sendJson } from '@ui/components/orgtruth/wizard/wizardApi';
import { CARD, INPUT, SMALL_BUTTON, InlineError } from '@ui/components/orgtruth/orgUi';
import { KNOWLEDGE, SOURCE_TYPES, CLASSIFICATIONS, ACCEPTED_FILES, transcriptRequest } from './knowledgeFormat';

const EMPTY = { text: '', displayName: '', observedAt: '', speaker: '', language: '', sourceType: 'interview', classification: 'internal' };
const LABEL = 'flex flex-col gap-1 text-xs font-medium text-gray-700 dark:text-gray-300';

function Field({ id, label, children }) {
  return <label htmlFor={id} className={LABEL}>{label}{children}</label>;
}

function Choice({ id, label, value, options, onChange }) {
  return (
    <Field id={id} label={label}>
      <select id={id} className={INPUT} value={value} onChange={e => onChange(e.target.value)}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </Field>
  );
}

function MetadataFields({ form, set }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Field id="kt-name" label="Name">
        <input id="kt-name" className={INPUT} value={form.displayName} onChange={e => set('displayName', e.target.value)} />
      </Field>
      <Field id="kt-date" label="Date">
        <input id="kt-date" type="date" className={INPUT} value={form.observedAt} onChange={e => set('observedAt', e.target.value)} />
      </Field>
      <Field id="kt-speaker" label="Speaker">
        <input id="kt-speaker" className={INPUT} value={form.speaker} onChange={e => set('speaker', e.target.value)} />
      </Field>
      <Field id="kt-language" label="Language">
        <input id="kt-language" className={INPUT} placeholder="nl, en, nl-NL" value={form.language} onChange={e => set('language', e.target.value)} />
      </Field>
      <Choice id="kt-type" label="Source type" value={form.sourceType} options={SOURCE_TYPES} onChange={v => set('sourceType', v)} />
      <Choice id="kt-class" label="Classification" value={form.classification} options={CLASSIFICATIONS} onChange={v => set('classification', v)} />
    </div>
  );
}

export default function TranscriptForm({ onAdded, onCancel }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const [form, setForm] = useState(EMPTY);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (key, value) => setForm(f => ({ ...f, [key]: value }));
  const ready = Boolean(file) || form.text.trim().length > 0;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const req = transcriptRequest(form, file);
      const path = `${KNOWLEDGE}/sources`;
      const row = req.kind === 'form' ? await sendForm(authFetch, path, req.data) : await sendJson(authFetch, path, req.data);
      dialog.toast(row.duplicate ? 'Already imported — opening it.' : 'Transcript added.', { variant: row.duplicate ? 'info' : 'success' });
      onAdded(row);
    } catch (err) {
      setError(`The transcript was not added: ${err.message}`);
      setBusy(false);
    }
  }

  return (
    <form className={`${CARD} space-y-3 p-4`} onSubmit={submit} aria-label="Add transcript">
      <InlineError message={error} />
      <Field id="kt-file" label="File (.txt, .md, .srt, .vtt)">
        <input id="kt-file" type="file" accept={ACCEPTED_FILES} className="text-sm text-gray-700 dark:text-gray-300"
          onChange={e => setFile(e.target.files?.[0] ?? null)} />
      </Field>
      {!file && (
        <Field id="kt-text" label="Or paste the transcript">
          <textarea id="kt-text" rows={6} className={INPUT} value={form.text} onChange={e => set('text', e.target.value)} />
        </Field>
      )}
      <MetadataFields form={form} set={set} />
      <div className="flex justify-end gap-2">
        <button type="button" className={SMALL_BUTTON} onClick={onCancel}>Cancel</button>
        <button type="submit" disabled={!ready || busy}
          className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600">
          {busy ? 'Adding…' : 'Add'}
        </button>
      </div>
    </form>
  );
}
