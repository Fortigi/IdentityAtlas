// Mentions of one transcript and their candidate matches — the "which object
// is this?" review, kept apart from whether a statement holds.
//
//   GET /knowledge/sources/:id/mentions
//   PUT /knowledge/matches/:linkId { action: confirm|reject|choose|reset, targetType?, targetId? }
//   PUT /knowledge/mentions/:id/choose { targetType, targetId }   (a mention without candidates)
//   PUT /knowledge/mentions/:id { label, type }                   (rename / retype)
//
// Open questions first: unmatched and ambiguous mentions are listed before the
// ones with clear candidates.
//
// Props: { sourceId, canEdit, onOpenDetail }
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import EmptyState from '@ui/components/EmptyState';
import { API } from '@ui/components/orgtruth/wizard/wizardApi';
import { fetchBlocked, rowsOf } from '@ui/components/orgtruth/orgFormat';
import { FetchState } from '@ui/components/orgtruth/orgUi';
import { KNOWLEDGE } from './knowledgeFormat';
import { useKnowledgeDecision } from './useKnowledgeDecision';
import MentionCard from './MentionCard';

const ORDER = { unmatched: 0, ambiguous: 1, candidates: 2 };
const byOpenFirst = (a, b) => (ORDER[a.resolution] ?? 3) - (ORDER[b.resolution] ?? 3);

export default function MentionsSection({ sourceId, canEdit, onOpenDetail }) {
  const { authFetch } = useAuth();
  const state = useFetch(`${API}${KNOWLEDGE}/sources/${encodeURIComponent(sourceId)}/mentions`, { authFetch });
  const { busy, decide } = useKnowledgeDecision(state.reload);
  const mentions = [...rowsOf(state.data)].sort(byOpenFirst);
  const onMatch = (linkId, body) => decide(`${KNOWLEDGE}/matches/${encodeURIComponent(linkId)}`, body);
  const onChooseFor = (mentionId, body) => decide(`${KNOWLEDGE}/mentions/${encodeURIComponent(mentionId)}/choose`, body);
  const onRename = (mentionId, body) => decide(`${KNOWLEDGE}/mentions/${encodeURIComponent(mentionId)}`, body);

  if (fetchBlocked(state)) return <FetchState state={state} what="Mentions" />;
  if (mentions.length === 0) return <EmptyState title="No mentions" hint="Run the extraction to find who and what this transcript mentions." />;
  return (
    <div className="space-y-3">
      {mentions.map(m => (
        <MentionCard key={m.id} mention={m} canEdit={canEdit} busy={Boolean(busy)} onMatch={onMatch} onChooseFor={onChooseFor} onRename={onRename} onOpenDetail={onOpenDetail} />
      ))}
    </div>
  );
}
