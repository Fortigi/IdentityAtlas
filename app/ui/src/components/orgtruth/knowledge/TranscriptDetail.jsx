// One transcript: its metadata, the extraction (start, progress, history), and
// the review sub-tabs — Statements (default), Mentions, Findings, Source.
//
// GET /api/org-truth/knowledge/sources/:id → { ...source, textContent, passages, runs }.
// A finished run bumps `round`, which remounts the active section so it fetches
// what the run wrote.
//
// Props: { sourceId, canEdit, onBack(), onOpenDetail }
import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import TabBar from '@ui/components/TabBar';
import { formatDateOnly } from '@ui/utils/formatters';
import { API } from '@ui/components/orgtruth/wizard/wizardApi';
import { fetchBlocked } from '@ui/components/orgtruth/orgFormat';
import { FetchState, LINK_BUTTON } from '@ui/components/orgtruth/orgUi';
import { KNOWLEDGE } from './knowledgeFormat';
import RunPanel from './RunPanel';
import ExportButton from './ExportButton';
import StatementsSection from './StatementsSection';
import MentionsSection from './MentionsSection';
import FindingsSection from './FindingsSection';
import SourceSection from './SourceSection';

const TABS = [
  { key: 'statements', label: 'Statements' },
  { key: 'mentions', label: 'Mentions' },
  { key: 'findings', label: 'Findings' },
  { key: 'source', label: 'Source' },
];

function metaLine(source) {
  const m = source.metadata ?? {};
  return [
    formatDateOnly(source.observedAt),
    m.speaker && `speaker ${m.speaker}`,
    m.language,
    m.sourceType,
    m.classification,
    m.format,
    `${source.passages?.length ?? source.passageCount ?? 0} passages`,
  ].filter(Boolean).join(' · ');
}

function Section({ tab, source, canEdit, onOpenDetail }) {
  if (tab === 'mentions') return <MentionsSection sourceId={source.id} canEdit={canEdit} onOpenDetail={onOpenDetail} />;
  if (tab === 'findings') return <FindingsSection sourceId={source.id} canEdit={canEdit} />;
  if (tab === 'source') return <SourceSection source={source} />;
  return <StatementsSection sourceId={source.id} passages={source.passages} canEdit={canEdit} />;
}

export default function TranscriptDetail({ sourceId, canEdit, onBack, onOpenDetail }) {
  const { authFetch } = useAuth();
  const state = useFetch(`${API}${KNOWLEDGE}/sources/${encodeURIComponent(sourceId)}`, { authFetch });
  const [tab, setTab] = useState('statements');
  const [round, setRound] = useState(0);
  const source = state.data;

  const onRunFinished = () => {
    state.reload();
    setRound(r => r + 1);
  };

  return (
    <div className="space-y-4">
      <button type="button" className={`${LINK_BUTTON} text-sm`} onClick={onBack}>← All transcripts</button>
      {fetchBlocked(state) && <FetchState state={state} what="Transcript" />}
      {source && (
        <>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{source.displayName}</h2>
              <p className="text-sm text-gray-600 dark:text-gray-400">{metaLine(source)}</p>
            </div>
            <ExportButton source={source} />
          </div>
          <RunPanel sourceId={source.id} runs={source.runs ?? []} canEdit={canEdit} onFinished={onRunFinished} />
          <TabBar tabs={TABS} active={tab} onChange={setTab} />
          <Section key={`${tab}-${round}`} tab={tab} source={source} canEdit={canEdit} onOpenDetail={onOpenDetail} />
        </>
      )}
    </div>
  );
}
