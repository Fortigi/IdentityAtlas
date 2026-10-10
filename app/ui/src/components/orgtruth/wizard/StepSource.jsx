// Import wizard step 2 — Source: choose the list (.xlsx / .csv), name it, say
// which moment it describes (defaults to the file's last-modified date), upload
// it (POST /api/org-truth/sources, multipart, no Content-Type header — the
// tools/crawlers/csv/ConfigWizard.jsx pattern) and show its column profile.
import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { WizardNav } from '@ui/components/crawler/wizardFields';
import { formatBytes } from '@ui/utils/formatters';
import { setSource, stepReady } from './wizardDraft';
import { isoDate, sendForm, sourceFromUpload } from './wizardApi';
import { Chip, Field, Notice, SMALL_BTN_CLS } from './wizardUi';

function ColumnList({ source }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-800 dark:text-gray-200">
        <span className="font-medium">{source.displayName}</span>
        {' — '}{source.rowCount ?? '—'} rows, {source.columns.length} columns
      </p>
      <ul className="flex flex-wrap gap-2" aria-label="Columns">
        {source.columns.map(c => (
          <li key={c.name} className="flex items-center gap-1 text-sm text-gray-800 dark:text-gray-200">
            {c.name} <Chip>{c.shape ?? 'text'}</Chip>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function StepSource({ draft, update, onBack, onNext, onError }) {
  const { authFetch } = useAuth();
  const [file, setFile] = useState(null);
  const [displayName, setDisplayName] = useState('');
  const [observedAt, setObservedAt] = useState('');
  const [uploading, setUploading] = useState(false);

  const choose = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setDisplayName(f.name);
    setObservedAt(isoDate(f.lastModified));
  };

  const upload = async () => {
    onError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      fd.append('kind', 'list');
      fd.append('displayName', displayName.trim() || file.name);
      if (observedAt) fd.append('observedAt', observedAt);
      const body = await sendForm(authFetch, '/sources', fd);
      update(d => setSource(d, sourceFromUpload(body)));
    } catch (e) {
      onError(`Upload failed: ${e.message}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <label className="px-4 py-2 bg-gray-100 text-gray-700 rounded text-sm hover:bg-gray-200 cursor-pointer dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600">
          Choose file
          <input type="file" accept=".xlsx,.csv" onChange={choose} className="hidden" />
        </label>
        <span className="text-sm text-gray-700 dark:text-gray-300">
          {file ? `${file.name} (${formatBytes(file.size)})` : 'An .xlsx or .csv list, first row = column headers.'}
        </span>
      </div>

      {file && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Display name" value={displayName} onChange={setDisplayName} />
          <Field label="Observed on" type="date" value={observedAt} onChange={setObservedAt}
            hint="The moment the list describes; a full import closes what it no longer contains as of this date." />
        </div>
      )}

      {file && (
        <button type="button" onClick={upload} disabled={uploading} className={SMALL_BTN_CLS}>
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
      )}

      {draft.source && <ColumnList source={draft.source} />}
      {!draft.source && !file && <Notice>Choose the list to import.</Notice>}

      <WizardNav onBack={onBack} onNext={onNext} nextDisabled={!stepReady(2, draft)} />
    </div>
  );
}
