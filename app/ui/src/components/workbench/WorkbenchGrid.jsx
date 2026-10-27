import { memo } from 'react';
import { cellKey, rangeKeys, cellImpact } from './workbench.model';
import { cellLook } from './workbench.cells';
import { MembershipBadge, BusinessRoleBadge } from '@ui/components/matrix/MatrixBadges';
import PersonCell from './PersonCell';

// ─── The workbench matrix ────────────────────────────────────────────────
// Rows: the unit's people, in the groups of the chosen dimension (a person with
// two activities is in both groups — the same person, the same cells: selecting
// one selects both). Columns: what they hold, most held first; a business role
// is marked R. Click a cell to select it, Shift-click for the rectangle from the
// last one, Ctrl/⌘-click to add or remove one; click a column header, a person
// or a group to select their held cells. The grid never edits access.

export default function WorkbenchGrid({ groups, columns, cellIndex, draft, dispatch, overlay, personProps }) {
  const rowKeys = groups.flatMap(g => g.rows.map(r => r.person.key));
  const colIds = columns.map(c => c.id);
  const { candidate, marks, selection } = draft;

  const pick = (keys, e, anchor) => dispatch({ type: 'select', keys, add: e.ctrlKey || e.metaKey, anchor });
  const onCell = (row, col, e) => {
    if (e.shiftKey && draft.anchor) {
      dispatch({ type: 'select', keys: [...rangeKeys(rowKeys, colIds, draft.anchor, { row, col })], add: e.ctrlKey || e.metaKey });
      return;
    }
    pick([cellKey(rowKeys[row], colIds[col])], e, { row, col });
  };
  const held = (personKeys, ids) => personKeys.flatMap(p => ids.map(r => cellKey(p, r))).filter(k => cellIndex.has(k));
  const onColumn = (col, e) => pick(held(rowKeys, [col.id]), e);
  const onPerson = (personKey, e) => pick(held([personKey], colIds), e);
  const onGroup = (group, e) => pick(held(group.rows.map(r => r.person.key), colIds), e);

  // Where each group's rows start in the flat row order (for Shift-click ranges).
  const starts = groups.reduce((acc, g, i) => [...acc, i === 0 ? 0 : acc[i - 1] + groups[i - 1].rows.length], []);
  return (
    <div className="overflow-auto rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800" style={{ maxHeight: 'calc(100vh - 260px)' }}>
      <table className="border-separate border-spacing-0 text-xs" aria-label="Access of the unit's people">
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 top-0 z-30 min-w-[16rem] border-b border-r border-gray-200 bg-gray-50 px-3 py-2 text-left align-bottom font-semibold text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
              Person <span className="font-normal text-gray-500 dark:text-gray-400">· what they do, know and hold</span>
            </th>
            {columns.map((col, i) => <ColumnHeader key={col.id} col={col} inCandidate={candidate.entitlements.has(col.id)} onClick={(e) => onColumn(col, e)} index={i} />)}
          </tr>
        </thead>
        <tbody>
          {groups.map((group, gi) => [
            <GroupRow key={`g:${group.key}`} group={group} span={columns.length} onSelect={(e) => onGroup(group, e)} />,
            ...group.rows.map(({ person, alsoIn, state }, ri) => {
              const row = starts[gi] + ri;
              return (
                <tr key={`${group.key}::${person.key}`}>
                  <PersonCell person={person} alsoIn={alsoIn} groupState={state} member={candidate.members.has(person.key)}
                    onSelectRow={(e) => onPerson(person.key, e)} {...personProps} />
                  {columns.map((col, c) => {
                    const k = cellKey(person.key, col.id);
                    return (
                      <GridCell key={col.id} cell={cellIndex.get(k)} mark={marks.get(k)} selected={selection.has(k)} overlay={overlay}
                        member={candidate.members.has(person.key)} inCandidate={candidate.entitlements.has(col.id)}
                        onClick={(e) => onCell(row, c, e)} />
                    );
                  })}
                </tr>
              );
            }),
          ])}
        </tbody>
      </table>
    </div>
  );
}

function ColumnHeader({ col, inCandidate, onClick }) {
  const title = [col.displayName, col.isRole ? 'Business role' : col.resourceType, col.systemName, `${col.holders} ${col.holders === 1 ? 'person' : 'people'}`]
    .filter(Boolean).join(' · ');
  return (
    <th scope="col" className={`sticky top-0 z-20 h-48 w-7 min-w-[1.75rem] border-b border-r border-gray-100 px-0 align-bottom dark:border-gray-700 ${inCandidate ? 'bg-emerald-50 dark:bg-emerald-900/30' : 'bg-gray-50 dark:bg-gray-900'}`}>
      <button type="button" onClick={onClick} title={title} aria-label={`Select the column ${title}`}
        className="flex h-48 w-7 items-end justify-center pb-1 hover:bg-blue-50 dark:hover:bg-blue-900/30">
        <span className="max-h-44 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-gray-700 dark:text-gray-200" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
          {col.isRole && <span className="mb-1 inline-block"><BusinessRoleBadge /></span>} {col.displayName}
        </span>
      </button>
    </th>
  );
}

function GroupRow({ group, span, onSelect }) {
  return (
    <tr>
      <th scope="rowgroup" colSpan={span + 1} className="sticky left-0 border-b border-t border-gray-200 bg-gray-100 px-3 py-1.5 text-left dark:border-gray-700 dark:bg-gray-900/80">
        <button type="button" onClick={onSelect} className="text-sm font-semibold text-gray-800 hover:underline dark:text-gray-100" title="Select what this group holds">
          {group.label}
        </button>
        <span className="ml-2 text-xs font-normal text-gray-600 dark:text-gray-400">
          {group.count} {group.count === 1 ? 'person' : 'people'}{group.allProposed ? ' · proposed only, not confirmed' : ''}
        </span>
      </th>
    </tr>
  );
}

const GridCell = memo(function GridCell({ cell, mark, selected, overlay, member, inCandidate, onClick }) {
  const impact = overlay ? cellImpact({ observed: !!cell, member, inCandidate, mark }) : null;
  const look = cellLook({ cell, mark, impact, overlay });
  const ring = selected ? 'outline outline-2 -outline-offset-2 outline-blue-600 dark:outline-blue-300' : '';
  const title = look?.title ?? 'Not held';
  return (
    <td className="h-7 w-7 border-b border-r border-gray-100 p-0 text-center dark:border-gray-700">
      <button type="button" onClick={onClick} title={title} aria-label={title} aria-pressed={selected}
        className={`relative flex h-7 w-7 select-none items-center justify-center ${look?.sign?.ring ?? ''} ${look ? '' : 'hover:bg-gray-100 dark:hover:bg-gray-700'} ${ring}`}>
        {look?.badge && <span className={look.dim ? 'opacity-40' : ''}><MembershipBadge type={look.badge} decorative /></span>}
        {look?.sign && (
          <span aria-hidden="true" className={`absolute right-0 top-0 flex h-3 min-w-[0.75rem] items-center justify-center rounded-bl px-0.5 text-[8px] font-bold leading-3 ${look.sign.mark}`}>
            {look.sign.glyph}
          </span>
        )}
      </button>
    </td>
  );
});