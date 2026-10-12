// The Source sub-tab: the transcript as passages (the §n the statements quote)
// or as the full text exactly as stored, plus the uploaded file itself.
//
//   GET /knowledge/sources/:id/original   (the uploaded bytes, as an attachment)
//
// Props: { source: { id, displayName, textContent, passages, metadata? } }
import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useDialog } from '@ui/components/dialogContext';
import EmptyState from '@ui/components/EmptyState';
import { API } from '@ui/components/orgtruth/wizard/wizardApi';
import { CARD, SMALL_BUTTON } from '@ui/components/orgtruth/orgUi';
import { KNOWLEDGE } from './knowledgeFormat';
import { downloadFile } from './knowledgeDownload';
import SourcePassages from './SourcePassages';

const VIEWS = [['passages', 'Passages'], ['full', 'Full text']];
const ACTIVE = 'bg-blue-600 text-white dark:bg-blue-500 dark:text-white';
const IDLE = 'bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700';

function FullText({ text }) {
  if (!text) return <EmptyState title="No text" hint="This transcript has no text." />;
  return (
    <pre aria-label="Full text" className={`${CARD} max-h-[70vh] overflow-auto whitespace-pre-wrap break-words p-4 font-sans text-sm text-gray-700 dark:text-gray-300`}>{text}</pre>
  );
}

export default function SourceSection({ source }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const [view, setView] = useState('passages');

  async function downloadOriginal() {
    const fallback = source.metadata?.fileName || `${source.displayName || source.id}.txt`;
    try {
      await downloadFile(authFetch, `${API}${KNOWLEDGE}/sources/${encodeURIComponent(source.id)}/original`, fallback);
    } catch (err) {
      dialog.alert(`The download failed: ${err.message}`);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex overflow-hidden rounded border border-gray-300 dark:border-gray-600" role="group" aria-label="Show">
          {VIEWS.map(([key, label]) => (
            <button key={key} type="button" aria-pressed={view === key} className={`px-3 py-1 text-xs ${view === key ? ACTIVE : IDLE}`} onClick={() => setView(key)}>{label}</button>
          ))}
        </div>
        <button type="button" className={SMALL_BUTTON} onClick={downloadOriginal}>Download original file</button>
      </div>
      {view === 'full' ? <FullText text={source.textContent} /> : <SourcePassages passages={source.passages} />}
    </div>
  );
}
