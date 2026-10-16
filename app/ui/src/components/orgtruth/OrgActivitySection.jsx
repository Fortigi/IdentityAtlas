// "Activity" on a collection entity's detail page: what activity lists
// (timesheets, logs) record against it — a bar per month and the people with
// their totals, their last activity, and whether (and as what) they are a
// member of it.
//
// The page owns the fetch (GET /api/org-truth/activity/subject/OrgEntity/:id,
// shape in activity.js) because the evidence section drops what this one
// shows. Nothing at all when no activity refers to the entity.
//
// Props: { state (useFetch result), onOpenDetail }
import { Section } from '@ui/components/DetailSection';
import { fetchBlocked, isMissingRoute } from './orgFormat';
import { monthBars, shortMonth, byTotalDesc, memberText, subjectLine, subjectEmpty, formatMeasure, formatOn, refDetailKind } from './activity';
import { FetchState, TH, TD, LINK_BUTTON } from './orgUi';

const BAR_H = 80;

function MonthChart({ months, unit }) {
  const bars = monthBars(months, BAR_H);
  if (bars.length === 0) return null;
  return (
    <ul aria-label="Activity per month" className="flex items-end gap-0.5 overflow-x-auto pb-1" style={{ minHeight: BAR_H + 20 }}>
      {bars.map(b => (
        <li key={b.month} className="flex w-8 shrink-0 flex-col items-center" title={`${b.label}: ${formatMeasure(b.total, unit)}`}
          aria-label={`${b.label}: ${formatMeasure(b.total, unit)}`}>
          <span className="w-5 rounded-t bg-blue-600 dark:bg-blue-400" style={{ height: b.height }} data-height={b.height} />
          <span className="mt-1 text-[10px] text-gray-600 dark:text-gray-400">{shortMonth(b.month)}</span>
        </li>
      ))}
    </ul>
  );
}

function ActorCell({ actor, onOpenDetail }) {
  const kind = refDetailKind(actor.targetType);
  if (!kind || !actor.targetId) return <span>{actor.label}</span>;
  return <button type="button" className={LINK_BUTTON} onClick={() => onOpenDetail?.(kind, actor.targetId, actor.label)}>{actor.label}</button>;
}

function PeopleTable({ actors, unit, onOpenDetail }) {
  if (actors.length === 0) return null;
  return (
    <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700" aria-label="People with activity">
      <thead><tr>{['Person', 'Total', 'Last activity', 'Member'].map(h => <th key={h} className={TH}>{h}</th>)}</tr></thead>
      <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
        {[...actors].sort(byTotalDesc).map(a => (
          <tr key={`${a.targetType}:${a.targetId}`}>
            <td className={TD}><ActorCell actor={a} onOpenDetail={onOpenDetail} /></td>
            <td className={TD}>{formatMeasure(a.total, unit)}</td>
            <td className={TD}>{formatOn(a.lastOn) || '—'}</td>
            <td className={`${TD} ${a.isMember ? '' : 'text-amber-700 dark:text-amber-300'}`}>{memberText(a)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function OrgActivitySection({ state, onOpenDetail }) {
  if (isMissingRoute(state.error)) return null;
  if (fetchBlocked(state)) return <Section title="Activity"><FetchState state={state} what="Activity" /></Section>;
  const activity = state.data;
  if (subjectEmpty(activity)) return null;
  return (
    <Section title="Activity">
      <div className="space-y-4">
        <p className="text-sm text-gray-700 dark:text-gray-300">{subjectLine(activity)}</p>
        <MonthChart months={activity.months} unit={activity.unit} />
        <PeopleTable actors={activity.actors ?? []} unit={activity.unit} onOpenDetail={onOpenDetail} />
      </div>
    </Section>
  );
}
