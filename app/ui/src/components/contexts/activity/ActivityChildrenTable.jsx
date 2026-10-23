import { formatAmount, monthLabel } from './activity.helpers';

// The activity table of a parent (a tree's root): its sub-units × months, with
// each sub-unit's total, its active people and the two suggestion counts
// (active, not a member; member, no activity), and a totals line. A sub-unit's
// name opens it.

export default function ActivityChildrenTable({ summary, onOpenDetail }) {
  const { months, unit, comparable } = summary;
  return (
    <div className="overflow-x-auto" data-testid="activity-children">
      <table className="w-full text-xs">
        <thead className="bg-gray-50 text-left text-gray-700 dark:bg-gray-700/50 dark:text-gray-300">
          <tr>
            <th scope="col" className="px-2 py-1 font-medium">Sub-unit</th>
            <th scope="col" className="px-2 py-1 text-right font-medium">Total</th>
            <th scope="col" className="px-2 py-1 text-right font-medium">Active people</th>
            {comparable && <th scope="col" className="px-2 py-1 text-right font-medium">Active, not a member</th>}
            {comparable && <th scope="col" className="px-2 py-1 text-right font-medium">Member, no activity</th>}
            {months.map(m => <th key={m} scope="col" className="px-1 py-1 text-right font-medium" title={monthLabel(m)}>{monthLabel(m, { short: true })}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
          {summary.children.map(c => (
            <tr key={c.contextId}>
              <th scope="row" className="px-2 py-1 text-left font-normal">
                {onOpenDetail
                  ? <button type="button" className="text-left text-blue-700 hover:underline dark:text-blue-300" onClick={() => onOpenDetail('context', c.contextId, c.displayName)}>{c.displayName}</button>
                  : <span className="text-gray-900 dark:text-gray-100">{c.displayName}</span>}
              </th>
              <td className="px-2 py-1 text-right tabular-nums text-gray-900 dark:text-gray-100">{formatAmount(c.total, unit)}</td>
              <td className="px-2 py-1 text-right tabular-nums text-gray-800 dark:text-gray-200">{c.activePeople}</td>
              {comparable && <td className="px-2 py-1 text-right tabular-nums"><Count n={c.activeNotMember} /></td>}
              {comparable && <td className="px-2 py-1 text-right tabular-nums"><Count n={c.memberNoActivity} /></td>}
              {c.perMonth.map(p => <td key={p.month} className="px-1 py-1 text-right tabular-nums text-gray-700 dark:text-gray-300">{p.amount ? p.amount : ''}</td>)}
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-gray-200 font-medium text-gray-900 dark:border-gray-700 dark:text-gray-100">
          <tr>
            <th scope="row" className="px-2 py-1 text-left">Total</th>
            <td className="px-2 py-1 text-right tabular-nums">{formatAmount(summary.totals.total, unit)}</td>
            <td />
            {comparable && <td />}
            {comparable && <td />}
            {summary.totals.perMonth.map(p => <td key={p.month} className="px-1 py-1 text-right tabular-nums">{p.amount ? p.amount : ''}</td>)}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// A suggestion count: highlighted when there is something to review.
function Count({ n }) {
  if (!n) return <span className="text-gray-600 dark:text-gray-400">0</span>;
  return <span className="rounded bg-amber-50 px-1 text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">{n}</span>;
}
