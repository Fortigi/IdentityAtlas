import { factClass, earlierRolesText } from '@ui/components/contexts/interviews/memberInterview.helpers';
import PersonClaims from './PersonClaims';
import { STATUS_CHIP, STATUS_LABELS, SOURCE_CHIP_LABELS, accessText, personLink, sourceChipTitle, statusTitle } from './people.helpers';

// ─── One person on the People overview ───────────────────────────────────
// A table row on a wide screen; on a narrow one a two-line card: the name, the
// roles they hold here and the status on the first line, the role, the sources,
// what they still hold and the claim icons on the second. The name opens the
// person's page (an account, else the person) where the page may link anywhere.
// `onRemove`: edit mode on a context created here, for a row its list holds.

const CELL = 'sm:py-1.5 sm:pr-3 align-middle';

export function StatusChip({ person }) {
  return (
    <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs ${STATUS_CHIP[person.status] || STATUS_CHIP.left}`}
      title={statusTitle(person)} data-testid="person-status" data-status={person.status}>
      {STATUS_LABELS[person.status] || person.status}
    </span>
  );
}

function RoleBadges({ roles }) {
  return roles.map(r => (
    <span key={r} className="ml-1.5 rounded border border-gray-300 px-1 text-xs text-gray-700 dark:border-gray-600 dark:text-gray-300" data-testid="person-role-badge">{r}</span>
  ));
}

function Name({ person, onOpenDetail }) {
  const link = personLink(person);
  if (!link || !onOpenDetail) return <span className="font-medium text-gray-900 dark:text-gray-100">{person.displayName}</span>;
  return (
    <button type="button" onClick={() => onOpenDetail(link.kind, link.id, person.displayName)}
      className="text-left font-medium text-blue-700 hover:underline dark:text-blue-300">{person.displayName}</button>
  );
}

function RoleCell({ person }) {
  const earlier = person.status === 'cameBack' ? earlierRolesText(person.rejoined) : '';
  return (
    <>
      {person.role && <span className={`text-gray-700 dark:text-gray-300 ${factClass(person.role.status)}`}>{person.role.value}</span>}
      {earlier && <span className="block text-xs text-gray-600 dark:text-gray-400">earlier: {earlier}</span>}
    </>
  );
}

function Sources({ sources, listName }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {sources.map(s => (
        <span key={s} title={sourceChipTitle(s, listName)} className="rounded bg-gray-100 px-1.5 text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-300">{SOURCE_CHIP_LABELS[s] || s}</span>
      ))}
    </span>
  );
}

function Access({ person, linkedResources }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5" title="Live entitlements held now">
      <span className="tabular-nums text-gray-700 dark:text-gray-300" data-testid="person-access">{accessText(person.liveEntitlements)}</span>
      {linkedResources > 0 && person.linkedEntitlements > 0 && (
        <span className="rounded bg-red-50 px-1 text-xs text-red-700 dark:bg-red-900/30 dark:text-red-300">{person.linkedEntitlements} here</span>
      )}
    </span>
  );
}

export default function PersonRow({ person, listName, linkedResources, onOpenDetail, onRemove }) {
  return (
    <tr data-testid="person-row" data-key={person.key}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-gray-100 py-2 text-sm dark:border-gray-700 sm:table-row sm:py-0">
      <td className={`basis-full sm:basis-auto ${CELL}`}>
        <span className="inline-flex flex-wrap items-center gap-x-1 gap-y-1">
          <Name person={person} onOpenDetail={onOpenDetail} />
          <RoleBadges roles={person.roles || []} />
          <span className="ml-1.5 sm:hidden"><StatusChip person={person} /></span>
        </span>
      </td>
      <td className={`hidden sm:table-cell ${CELL}`}><StatusChip person={person} /></td>
      <td className={CELL}><RoleCell person={person} /></td>
      <td className={CELL}><Sources sources={person.sources || []} listName={listName} /></td>
      <td className={`${CELL} sm:text-right`}><Access person={person} linkedResources={linkedResources} /></td>
      <td className={CELL}><PersonClaims person={person} /></td>
      {onRemove && (
        <td className={`${CELL} sm:text-right`}>
          {(person.sources || []).includes('list') && (
            <button type="button" onClick={() => onRemove(person)} className="text-xs text-red-700 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300">Remove</button>
          )}
        </td>
      )}
    </tr>
  );
}
