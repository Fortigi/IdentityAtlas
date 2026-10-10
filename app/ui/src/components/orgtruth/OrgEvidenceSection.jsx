// "Evidence from other lists" on the org-entity detail page: does the team the
// list names match who really wrote hours on it (e.g. a timesheet), and is the
// entity still worked on?
//
// GET /api/org-truth/entities/:id/evidence (shape in evidence.js). Renders a
// verdict pill and the activity line, one table per attribute the entity links
// people through (`via`: owner, team, …), and the people who worked on it but
// are in none of those. Nothing at all when no person is linked and no other
// list refers to the entity; a 501 renders "not available yet". `compact`
// (the Activity section already shows the activity): only the listed-people
// tables, without the activity verdict and the worked-but-not-listed table.
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { Section } from '@ui/components/DetailSection';
import { fetchBlocked } from './orgFormat';
import { activityVerdict, activityLine, evidenceEmpty, formatHours, formatPeriod, summarizePeople, verdictPillClass, workedText } from './evidence';
import { FetchState, TH, TD, LINK_BUTTON } from './orgUi';

const TITLE = 'Evidence from other lists';
const SUBHEAD = 'text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400 mb-1';

// heroicons check (20 solid); the words next to it carry the meaning.
function CheckIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd" />
    </svg>
  );
}

function PersonButton({ person, onOpenDetail }) {
  return (
    <button type="button" className={LINK_BUTTON} onClick={() => onOpenDetail?.('user', person.principalId, person.label)}>
      {person.label}
    </button>
  );
}

function PeopleTable({ title, headers, rows, renderRow }) {
  return (
    <div>
      <h4 className={SUBHEAD}>{title}</h4>
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead><tr>{headers.map(h => <th key={h} className={TH}>{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">{rows.map(renderRow)}</tbody>
      </table>
    </div>
  );
}

function ViaTable({ group, onOpenDetail }) {
  return (
    <PeopleTable title={group.via} headers={['Person', 'Worked on it', 'Hours']} rows={group.principals || []}
      renderRow={p => (
        <tr key={p.principalId}>
          <td className={TD}><PersonButton person={p} onOpenDetail={onOpenDetail} /></td>
          <td className={TD}>
            <span className={`inline-flex items-center gap-1 ${p.worked ? 'text-green-700 dark:text-green-300' : 'text-amber-700 dark:text-amber-300'}`}>
              {p.worked && <CheckIcon />}{workedText(p)}
            </span>
          </td>
          <td className={TD}>{formatHours(p.hours)}</td>
        </tr>
      )} />
  );
}

function NotListedTable({ rows, onOpenDetail }) {
  return (
    <PeopleTable title="Worked on it but not listed" headers={['Person', 'Hours', 'Last period']} rows={rows}
      renderRow={p => (
        <tr key={p.principalId}>
          <td className={TD}><PersonButton person={p} onOpenDetail={onOpenDetail} /></td>
          <td className={TD}>{formatHours(p.hours)}</td>
          <td className={TD}>{formatPeriod(p.lastPeriod) || '—'}</td>
        </tr>
      )} />
  );
}

function ActivityHeader({ activity, people }) {
  const verdict = activityVerdict(activity);
  const { listed, worked } = summarizePeople(people);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span data-verdict={verdict.kind} className={`inline-block px-2 py-0.5 rounded-full text-xs ${verdictPillClass(verdict.kind)}`}>
          {verdict.text}
        </span>
        {listed > 0 && <span className="text-sm text-gray-600 dark:text-gray-400">{worked} of {listed} listed people wrote hours on it</span>}
      </div>
      {activity && <p className="text-sm text-gray-700 dark:text-gray-300">{activityLine(activity)}</p>}
    </div>
  );
}

export default function OrgEvidenceSection({ entityId, onOpenDetail, compact = false }) {
  const { authFetch } = useAuth();
  const state = useFetch(`/api/org-truth/entities/${encodeURIComponent(entityId)}/evidence`, { authFetch });
  if (fetchBlocked(state)) return <Section title={TITLE}><FetchState state={state} what="Evidence" /></Section>;
  const evidence = state.data;
  const people = evidence?.people || [];
  if (evidenceEmpty(evidence) || (compact && people.length === 0)) return null;
  const notListed = compact ? [] : evidence.workedNotListed || [];
  return (
    <Section title={TITLE}>
      <div className="space-y-4">
        {!compact && <ActivityHeader activity={evidence.activity} people={people} />}
        {people.map(g => <ViaTable key={g.via} group={g} onOpenDetail={onOpenDetail} />)}
        {notListed.length > 0 && <NotListedTable rows={notListed} onOpenDetail={onOpenDetail} />}
      </div>
    </Section>
  );
}
