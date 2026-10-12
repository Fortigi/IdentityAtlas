// Findings of one transcript: issues (contradictions, gaps) and follow-up
// questions for the next interview, each with Dismiss / Resolve / Reopen.
//
//   GET /knowledge/sources/:id/findings
//   PUT /knowledge/findings/:id { status: open|dismissed|resolved }
//
// Props: { sourceId, canEdit }
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import EmptyState from '@ui/components/EmptyState';
import { API } from '@ui/components/orgtruth/wizard/wizardApi';
import { fetchBlocked, rowsOf, pillColorClass } from '@ui/components/orgtruth/orgFormat';
import { FetchState, CARD, SMALL_BUTTON } from '@ui/components/orgtruth/orgUi';
import { KNOWLEDGE } from './knowledgeFormat';
import { useKnowledgeDecision } from './useKnowledgeDecision';

const KIND_LABEL = { issue: 'Issue', question: 'Question' };
const STATUS_COLOR = { open: 'amber', dismissed: 'gray', resolved: 'green' };

function Finding({ finding, canEdit, busy, onSet }) {
  const set = (status) => onSet(finding, status);
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 py-2">
      <div className="text-sm text-gray-700 dark:text-gray-300">
        <span className="mr-2 font-medium text-gray-900 dark:text-gray-100">{KIND_LABEL[finding.kind] ?? finding.kind}</span>
        {finding.category && <span className="mr-2 text-xs text-gray-600 dark:text-gray-400">{finding.category}</span>}
        <span className={`mr-2 inline-block rounded-full px-2 py-0.5 text-xs ${pillColorClass(STATUS_COLOR[finding.status])}`}>{finding.status}</span>
        <p>{finding.text}</p>
      </div>
      {canEdit && (
        <div className="flex gap-2">
          {finding.status === 'open'
            ? <>
              <button type="button" disabled={busy} className={SMALL_BUTTON} onClick={() => set('dismissed')}>Dismiss</button>
              <button type="button" disabled={busy} className={SMALL_BUTTON} onClick={() => set('resolved')}>Resolve</button>
            </>
            : <button type="button" disabled={busy} className={SMALL_BUTTON} onClick={() => set('open')}>Reopen</button>}
        </div>
      )}
    </li>
  );
}

export default function FindingsSection({ sourceId, canEdit }) {
  const { authFetch } = useAuth();
  const state = useFetch(`${API}${KNOWLEDGE}/sources/${encodeURIComponent(sourceId)}/findings`, { authFetch });
  const { busy, decide } = useKnowledgeDecision(state.reload);
  const findings = rowsOf(state.data);
  const onSet = (finding, status) => decide(`${KNOWLEDGE}/findings/${encodeURIComponent(finding.id)}`, { status });

  if (fetchBlocked(state)) return <FetchState state={state} what="Findings" />;
  if (findings.length === 0) return <EmptyState title="No findings" hint="No issues or follow-up questions for this transcript." />;
  return (
    <ul className={`${CARD} divide-y divide-gray-100 px-4 dark:divide-gray-700`} aria-label="Findings">
      {findings.map(f => <Finding key={f.id} finding={f} canEdit={canEdit} busy={Boolean(busy)} onSet={onSet} />)}
    </ul>
  );
}
