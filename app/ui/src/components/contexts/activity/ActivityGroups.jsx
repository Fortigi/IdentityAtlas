import MonthBars from './MonthBars';
import { groupInfo, formatAmount, personLink } from './activity.helpers';

// The people of one context's activity in its groups (member and active,
// active not a member, member without activity, unknown person): per person the
// amount, the first and last date and a bar per month. The two suggestion
// groups are marked as such — activity never changes the members.

export default function ActivityGroups({ view, onOpenDetail }) {
  return (
    <div className="space-y-3" data-testid="activity-groups">
      {view.groups.map(g => <Group key={g.key} group={g} unit={view.unit} onOpenDetail={onOpenDetail} />)}
    </div>
  );
}

function Group({ group, unit, onOpenDetail }) {
  const info = groupInfo(group.key);
  const idle = group.key === 'memberNoActivity';
  return (
    <section aria-label={info.label} data-testid={`activity-group-${group.key}`}>
      <h4 className="text-xs font-semibold text-gray-800 dark:text-gray-200">
        {info.label} <span className="font-normal text-gray-600 dark:text-gray-400">({group.people.length})</span>
        {info.suggestion && group.people.length > 0 && (
          <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">suggestion</span>
        )}
      </h4>
      <p className="text-[11px] text-gray-600 dark:text-gray-400">{info.help}</p>
      {group.people.length > 0 && (
        <table className="mt-1 w-full text-xs">
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {group.people.map(p => <PersonRow key={personKey(p)} person={p} unit={unit} idle={idle} onOpenDetail={onOpenDetail} />)}
          </tbody>
        </table>
      )}
    </section>
  );
}

const personKey = (p) => p.identityId || p.principalId || p.memberId || `${p.subjectEmail}|${p.subjectName}`;

function PersonRow({ person, unit, idle, onOpenDetail }) {
  const link = onOpenDetail ? personLink(person) : null;
  const name = link
    ? <button type="button" className="text-left text-blue-700 hover:underline dark:text-blue-300" onClick={() => onOpenDetail(link.kind, link.id, person.displayName)}>{person.displayName}</button>
    : <span className="text-gray-900 dark:text-gray-100">{person.displayName}</span>;
  return (
    <tr>
      <td className="py-1 pr-2">{name}{person.subjectEmail && person.subjectEmail !== person.displayName && <span className="block text-[11px] text-gray-600 dark:text-gray-400">{person.subjectEmail}</span>}</td>
      {!idle && <td className="py-1 pr-2 text-right tabular-nums text-gray-900 dark:text-gray-100">{formatAmount(person.amount, unit)}</td>}
      {!idle && <td className="py-1 pr-2 text-gray-700 dark:text-gray-300">{person.firstDate} – {person.lastDate}</td>}
      {!idle && <td className="py-1 text-right"><MonthBars perMonth={person.perMonth} unit={unit} /></td>}
    </tr>
  );
}
