// Org Info → Knowledge (experimental, flag `knowledgeExtraction`).
//
// An analyst adds an interview transcript; the deployment's own local model
// extracts mentions and statements with exact quotes; everything it proposes
// waits for review. This panel is the list of transcripts plus "Add transcript";
// selecting one opens TranscriptDetail. The server is the source of truth: every
// decision refetches, nothing is kept in local state beyond the selection.
//
// Routes: GET /api/org-truth/knowledge/status and /sources.
import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useCanImportOrgTruth } from '@ui/hooks/useCanImportOrgTruth';
import EmptyState from '@ui/components/EmptyState';
import { API } from '@ui/components/orgtruth/wizard/wizardApi';
import { fetchBlocked, rowsOf } from '@ui/components/orgtruth/orgFormat';
import { FetchState, SMALL_BUTTON } from '@ui/components/orgtruth/orgUi';
import { KNOWLEDGE } from './knowledgeFormat';
import ModelStatusBanner from './ModelStatusBanner';
import TranscriptForm from './TranscriptForm';
import TranscriptList from './TranscriptList';
import TranscriptDetail from './TranscriptDetail';

export default function KnowledgeTab({ onOpenDetail }) {
  const { authFetch } = useAuth();
  const canEdit = useCanImportOrgTruth();
  const status = useFetch(`${API}${KNOWLEDGE}/status`, { authFetch });
  const sources = useFetch(`${API}${KNOWLEDGE}/sources`, { authFetch });
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);

  const onAdded = (row) => {
    setAdding(false);
    sources.reload();
    setSelected(row.id);
  };
  const onBack = () => {
    setSelected(null);
    sources.reload();
    status.reload();
  };

  if (selected) {
    return <TranscriptDetail sourceId={selected} canEdit={canEdit} onBack={onBack} onOpenDetail={onOpenDetail} />;
  }

  const rows = rowsOf(sources.data);
  return (
    <div className="space-y-4">
      <ModelStatusBanner status={status.data} />
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Interview transcripts, read only by this deployment&apos;s own model. Every match and statement waits for review.
        </p>
        {canEdit && !adding && (
          <button type="button" className={SMALL_BUTTON} onClick={() => setAdding(true)}>Add transcript</button>
        )}
      </div>
      {adding && <TranscriptForm onAdded={onAdded} onCancel={() => setAdding(false)} />}
      {fetchBlocked(sources) && <FetchState state={sources} what="Transcripts" />}
      {!fetchBlocked(sources) && rows.length === 0 && (
        <EmptyState title="No transcripts yet" hint="Add an interview transcript to extract who and what it mentions." />
      )}
      {rows.length > 0 && <TranscriptList rows={rows} onOpen={setSelected} />}
    </div>
  );
}
