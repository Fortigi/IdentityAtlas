// "From interviews": the accepted statements about one object, on its detail
// page — the text, the exact quote, and which transcript said it when.
//
// GET /api/org-truth/knowledge/statements?targetType=&targetId= (statements an
// analyst accepted, through mentions an analyst linked to this object). Only
// with the Org Info and knowledgeExtraction flags on; a failure or an empty
// list renders nothing.
//
// Props: { targetType: 'OrgEntity'|'Identity'|'Principal'|'Resource'|'Context', targetId }
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useFeatureFlags } from '@ui/contexts/FeaturesContext';
import { Section } from '@ui/components/DetailSection';
import { formatDateOnly } from '@ui/utils/formatters';
import { API } from '@ui/components/orgtruth/wizard/wizardApi';
import { buildQuery, rowsOf } from '@ui/components/orgtruth/orgFormat';
import { KNOWLEDGE } from './knowledgeFormat';

export default function InterviewStatementsPanel({ targetType, targetId }) {
  const { authFetch } = useAuth();
  const features = useFeatureFlags();
  const enabled = features.orgTruth === true && features.knowledgeExtraction === true && Boolean(targetId);
  const state = useFetch(`${API}${KNOWLEDGE}/statements${buildQuery({ targetType, targetId })}`, { authFetch, enabled });
  const rows = enabled && !state.error ? rowsOf(state.data) : [];
  if (rows.length === 0) return null;

  return (
    <Section title="From interviews" count={rows.length}>
      <ul className="space-y-2">
        {rows.map(s => (
          <li key={s.id} className="text-sm text-gray-700 dark:text-gray-300">
            <p>{s.text}</p>
            {s.quote && <p className="italic text-gray-600 dark:text-gray-400">“{s.quote}”</p>}
            <p className="text-xs text-gray-600 dark:text-gray-400">
              {[s.sourceName, formatDateOnly(s.observedAt)].filter(Boolean).join(' · ')}
            </p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
