import MatrixCell from '@ui/components/matrix/MatrixCell';
import MatrixApLabelCell from '@ui/components/matrix/MatrixApLabelCell';
import { cellKey, rangeKeys } from './workbench.model';
import { cellProps, roleCellProps, cellLabel, DRAFT_ID } from './workbench.roles';
import { MARK_LEGEND } from './workbench.cells';
import { PeopleHeader, PersonCells } from './PeopleCells';

// ─── The workbench matrix ────────────────────────────────────────────────
// Rows: the unit's people, in the groups of the chosen dimension (a person with
// two activities is in both groups — the same person, the same cells: selecting
// one selects both). Columns: what they hold, most held first; then, as in the
// matrix, the business-role band on the right — the unit's roles and the
// candidate as "Draft: <name>" — each in its matrix colour. Every cell is the
// matrix's own MatrixCell (badge, role colour, marker strip — workbench.roles.js
// maps the candidate onto it); the analyst's marks sit on top. Click a cell to
// select it, Shift-click for the rectangle from the last one, Ctrl/⌘-click to add
// or remove one; click a column header, a person or a group to select their held
// cells. The grid never edits access.

const MARK_SIGN = Object.fromEntries(MARK_LEGEND.map(m => [m.key, m]));

function MarkSign({ mark }) {
  if (!mark) return null;
  const s = MARK_SIGN[mark];
  return (
    <span aria-hidden="true" className={`absolute bottom-0 right-0 flex h-3 min-w-[0.75rem] items-center justify-center rounded-tl px-0.5 text-[8px] font-bold leading-3 ${s.mark}`}>
      {s.glyph}
    </span>
  );
}

export default function WorkbenchGrid({ groups, columns, roles, color, isDark, cellIndex, draft, dispatch, personProps, onOpenDetail, people }) {
  const { peopleColumns, offsets, allPeople, filters, sort, onSort, onFilter, grouped } = people;
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
  const openRole = (type, id, name) => (id === DRAFT_ID ? undefined : onOpenDetail?.('resource', id, name));

  // Where each group's rows start in the flat row order (for Shift-click ranges).
  const starts = groups.reduce((acc, g, i) => [...acc, i === 0 ? 0 : acc[i - 1] + groups[i - 1].rows.length], []);
  return (
    <div className="overflow-auto rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800" style={{ maxHeight: 'calc(100vh - 260px)' }}>
      <table className="border-separate border-spacing-0 text-xs" aria-label="Access of the unit's people">
        <thead>
          <tr>
            <PeopleHeader columns={peopleColumns} offsets={offsets} people={allPeople} filters={filters} sort={sort} onSort={onSort} onFilter={onFilter} />
            {columns.map(col => <ColumnHeader key={col.id} col={col} inCandidate={candidate.entitlements.has(col.id)} onClick={(e) => onColumn(col, e)} />)}
            {roles.map((r, i) => <MatrixApLabelCell key={r.id} accessPackages={roles} idx={i} isDark={isDark} onOpenDetail={openRole} />)}
          </tr>
        </thead>
        <tbody>
          {groups.map((group, gi) => [
            grouped && <GroupRow key={`g:${group.key}`} group={group} span={peopleColumns.length + columns.length + roles.length - 1} onSelect={(e) => onGroup(group, e)} />,
            ...group.rows.map(({ person, repeat }, ri) => {
              const row = starts[gi] + ri;
              return (
                <tr key={`${group.key}::${person.key}`} className={repeat ? 'opacity-50' : undefined} data-repeat={repeat || undefined}>
                  <PersonCells person={person} columns={peopleColumns} offsets={offsets} member={candidate.members.has(person.key)}
                    onSelectRow={(e) => onPerson(person.key, e)} {...personProps} />
                  {columns.map((col, c) => {
                    const k = cellKey(person.key, col.id);
                    const props = cellProps({ cell: cellIndex.get(k), personKey: person.key, resourceId: col.id, roles, color });
                    return (
                      <MatrixCell key={col.id} cellKey={k} {...props} selected={selection.has(k)} label={cellLabel(props, marks.get(k))}
                        onSelect={(e) => onCell(row, c, e)}>
                        <MarkSign mark={marks.get(k)} />
                      </MatrixCell>
                    );
                  })}
                  {roles.map(role => (
                    <RoleCell key={role.id} role={role} personKey={person.key} cellIndex={cellIndex} color={color}
                      selection={selection} marks={marks} pick={pick} />
                  ))}
                </tr>
              );
            }),
          ])}
        </tbody>
      </table>
    </div>
  );
}

// A person in a role's own column: holding it (the role's colour), or — for the
// draft — about to (its provisioning gap). An existing role's cell can be selected
// like any held access; the draft's cannot (it is no access yet).
function RoleCell({ role, personKey, cellIndex, color, selection, marks, pick }) {
  const props = roleCellProps({ role, personKey, cellIndex, color });
  const k = cellKey(personKey, role.id);
  const selectable = !role.draft;
  return (
    <MatrixCell cellKey={k} {...props} selected={selectable && selection.has(k)} label={cellLabel(props, marks.get(k))}
      onSelect={selectable ? (e) => pick([k], e) : undefined}>
      <MarkSign mark={marks.get(k)} />
    </MatrixCell>
  );
}

function ColumnHeader({ col, inCandidate, onClick }) {
  const title = [col.displayName, col.resourceType, col.systemName, `${col.holders} ${col.holders === 1 ? 'person' : 'people'}`]
    .filter(Boolean).join(' · ');
  return (
    <th scope="col" className={`sticky top-0 z-20 h-48 w-6 min-w-[1.5rem] border-b border-r border-gray-100 px-0 align-bottom dark:border-gray-700 ${inCandidate ? 'bg-emerald-50 dark:bg-emerald-900/30' : 'bg-gray-50 dark:bg-gray-900'}`}>
      <button type="button" onClick={onClick} title={title} aria-label={`Select the column ${title}`}
        className="flex h-48 w-6 items-end justify-center pb-1 hover:bg-blue-50 dark:hover:bg-blue-900/30">
        <span className="max-h-44 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-gray-700 dark:text-gray-200" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
          {col.displayName}
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
