// Statements of one transcript, filtered by review status (default: proposed;
// statements the verifier threw out are under "rejected") and grouped by
// confidence band (default: High, Medium, Low) or by topic. While reviewing
// proposed statements, each group — and the whole list — can be accepted or
// rejected at once; "Score again" recomputes the confidence and the data check.
//
//   GET  /knowledge/sources/:id/claims?status=
//   PUT  /knowledge/claims/:id { status, expectedStatus, predicate?, qualifier? }
//   PUT  /knowledge/sources/:id/claims/bulk { status, ids }
//   PUT  /knowledge/mentions/:id { label, type }
//   POST /knowledge/sources/:id/rescore
//
// Props: { sourceId, passages, canEdit }
import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import EmptyState from '@ui/components/EmptyState';
import { API } from '@ui/components/orgtruth/wizard/wizardApi';
import { buildQuery, fetchBlocked, rowsOf } from '@ui/components/orgtruth/orgFormat';
import { FetchState, CARD, INPUT, SMALL_BUTTON } from '@ui/components/orgtruth/orgUi';
import { KNOWLEDGE, groupByBand, topicGroups } from './knowledgeFormat';
import { useKnowledgeDecision } from './useKnowledgeDecision';
import { useStatementBulk } from './useStatementBulk';
import StatementRow from './StatementRow';
import BulkButtons from './BulkButtons';

const FILTERS = [['proposed', 'Proposed'], ['accepted', 'Accepted'], ['rejected', 'Rejected'], ['', 'All']];
const GROUPINGS = [['confidence', 'Confidence'], ['topic', 'Topic']];
const LABEL = 'flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300';

function Choice({ label, value, options, onChange }) {
  return (
    <label className={LABEL}>
      {label}
      <select className={INPUT} value={value} onChange={e => onChange(e.target.value)}>
        {options.map(([v, text]) => <option key={text} value={v}>{text}</option>)}
      </select>
    </label>
  );
}

function Group({ group, grouping, bulkable, busy, onBulk, rowProps }) {
  const aria = grouping === 'topic' ? `Topic ${group.title}` : group.title;
  return (
    <section className={`${CARD} px-4 py-2`} aria-label={aria}>
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
          {group.title} ({group.claims.length})
          {group.hint && <span className="ml-2 font-normal normal-case">{group.hint}</span>}
        </h4>
        {bulkable && <BulkButtons claims={group.claims} scope={group.scope} busy={busy} onBulk={onBulk} />}
      </div>
      <ul className="divide-y divide-gray-100 dark:divide-gray-700">
        {group.claims.map(c => <StatementRow key={c.id} claim={c} {...rowProps(c)} />)}
      </ul>
    </section>
  );
}

export default function StatementsSection({ sourceId, passages, canEdit }) {
  const { authFetch } = useAuth();
  const [status, setStatus] = useState('proposed');
  const [grouping, setGrouping] = useState('confidence');
  const state = useFetch(`${API}${KNOWLEDGE}/sources/${encodeURIComponent(sourceId)}/claims${buildQuery({ status })}`, { authFetch });
  const { busy, decide } = useKnowledgeDecision(state.reload);
  const bulkState = useStatementBulk(sourceId, state.reload);
  const claims = rowsOf(state.data);
  const groups = grouping === 'topic' ? topicGroups(claims) : groupByBand(claims);
  const bulkable = canEdit && status === 'proposed';
  const anyBusy = Boolean(busy || bulkState.busy);
  const claimPath = (c) => `${KNOWLEDGE}/claims/${encodeURIComponent(c.id)}`;
  const onDecide = (claim, body) => decide(claimPath(claim), body);
  const onRename = (mentionId, body) => decide(`${KNOWLEDGE}/mentions/${encodeURIComponent(mentionId)}`, body);
  const rowProps = (c) => ({ passages, canEdit, busy: busy === claimPath(c), onDecide, onRename });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4">
        <Choice label="Status" value={status} options={FILTERS} onChange={setStatus} />
        <Choice label="Group by" value={grouping} options={GROUPINGS} onChange={setGrouping} />
        {bulkable && <BulkButtons claims={claims} scope={null} label="all shown" busy={anyBusy} onBulk={bulkState.bulk} />}
        {canEdit && <button type="button" disabled={anyBusy} className={SMALL_BUTTON} onClick={bulkState.rescore}>Score again</button>}
      </div>
      {fetchBlocked(state) && <FetchState state={state} what="Statements" />}
      {!fetchBlocked(state) && groups.length === 0 && <EmptyState title="No statements" hint="Nothing with this status for this transcript." />}
      {groups.map(g => (
        <Group key={g.key} group={g} grouping={grouping} bulkable={bulkable} busy={anyBusy} onBulk={bulkState.bulk} rowProps={rowProps} />
      ))}
    </div>
  );
}
