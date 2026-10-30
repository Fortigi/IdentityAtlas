import { useMemo, useRef, useState } from 'react';
import MatrixCell from '@ui/components/matrix/MatrixCell';
import { cellKey, rangeKeys } from './workbench.model';
import { cellProps, cellLabel } from './workbench.roles';
import { transposedRows, resourceOrder, headerColumns } from './workbench.transposed';
import { MarkSign, RoleCell } from './WorkbenchGrid';
import PeopleHeaderRows from './PeopleHeaderRows';
import { PermissionHeaderCells } from './PermissionFilters';
import PageStickyTable from './PageStickyTable';
import { usePageVirtualRows } from './usePageVirtualRows';

// ─── The workbench matrix, people as columns ─────────────────────────────
// The global matrix's orientation (workbench.transposed.js): one column per person
// shown, what is known of them as header rows above (PeopleHeaderRows); rows are
// the business roles of the band — the unit's, then the proposed ones as
// "Draft: <name>" — each in its matrix colour with the entitlements it contains
// nested under it (fold a role to hide them), then "Other access". The access rows
// carry the matrix's row cells — name, Contexts, type, system, held by — each with
// the same Excel-like filter and sort the people have (PermissionFilters). Every
// cell is the matrix's own MatrixCell and means what it means with people as
// rows: the same cell keys, the same selection (click; Shift-click a rectangle;
// Ctrl/⌘-click one more), the same marks. Click a person's name or a resource to
// select what they hold; click a role to open it in the panel. The page scrolls,
// not the grid; its header rows stay at the top of the window (PageStickyTable).
// Rows are virtualised against the page, so a unit whose people hold hundreds of
// groups stays quick.

const ROW_HEIGHT = 26;
// Resource name, Contexts, Type, System, Held by — the order of PERMISSION_COLUMNS.
const WIDTHS = [240, 150, 84, 90, 52];
// All five stay in place when the grid scrolls sideways (the people scroll under them),
// as the header's row labels above them do.
const LEFT_AT = WIDTHS.map((_, i) => WIDTHS.slice(0, i).reduce((a, w) => a + w, 0));
const STICKY_NAME = 'sticky left-0 z-10 border-b border-r border-gray-200 dark:border-gray-700';
const STUCK = 'sticky z-10';
const ROW_BG = 'bg-white dark:bg-gray-800';
const CELL = 'truncate border-b border-r border-gray-100 px-1 text-[11px] dark:border-gray-700';

export default function WorkbenchColumnsGrid({ people: shownPeople, columns, columnsById, roles, color, cellIndex, draft, candidate, dispatch, personProps, header }) {
  const [folded, setFolded] = useState(() => new Set());
  const rows = useMemo(() => transposedRows(roles, columns, columnsById, folded), [roles, columns, columnsById, folded]);
  const headerCols = useMemo(() => headerColumns(header.peopleColumns), [header.peopleColumns]);
  const bodyRef = useRef(null);
  const { items, padTop, padBottom } = usePageVirtualRows(bodyRef, rows.length, ROW_HEIGHT);

  const { marks, selection } = draft;
  const peopleKeys = shownPeople.map(p => p.key);
  const resIds = resourceOrder(rows);
  const resIndex = new Map(resIds.map((id, i) => [id, i]));

  const pick = (keys, e, anchor) => dispatch({ type: 'select', keys, add: e.ctrlKey || e.metaKey, anchor });
  // The anchor is (person, resource) by position, as with people as rows.
  const onCell = (p, resourceId, e) => {
    const at = { row: p, col: resIndex.get(resourceId) };
    if (e.shiftKey && draft.anchor) {
      dispatch({ type: 'select', keys: [...rangeKeys(peopleKeys, resIds, draft.anchor, at)], add: e.ctrlKey || e.metaKey });
      return;
    }
    pick([cellKey(peopleKeys[p], resourceId)], e, at);
  };
  const held = (personKeys, ids) => personKeys.flatMap(p => ids.map(r => cellKey(p, r))).filter(k => cellIndex.has(k));
  const onResource = (col, e) => pick(held(peopleKeys, [col.id]), e);
  const onPerson = (personKey, e) => pick(held([personKey], resIds), e);
  const openRole = (id) => dispatch(id.startsWith('draft:') ? { type: 'selectDraft', id } : { type: 'viewRole', id });
  const toggleFold = (id) => setFolded(f => { const n = new Set(f); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const span = WIDTHS.length + shownPeople.length;
  const ctx = header.perms.ctx;
  return (
    <PageStickyTable label="Access of the unit's people, people as columns" bodyRef={bodyRef} widths={[...WIDTHS, ...shownPeople.map(() => 24)]}
      head={(
        <>
          <PeopleHeaderRows columns={headerCols} people={shownPeople} header={header} labelSpan={WIDTHS.length}
            members={candidate.members} onPerson={onPerson} personProps={personProps} />
          <tr data-permission-header>
            <PermissionHeaderCells perms={header.perms} widths={WIDTHS} />
            {shownPeople.map(p => <th key={p.key} aria-hidden="true" className="border-b border-r border-gray-100 bg-gray-50 dark:border-gray-700 dark:bg-gray-900" />)}
          </tr>
        </>
      )}>
          {padTop > 0 && <tr aria-hidden="true"><td colSpan={span} style={{ height: padTop, padding: 0, border: 'none' }} /></tr>}
          {items.map(item => {
            const row = rows[item.index];
            if (row.type === 'role') {
              return <RoleRow key={row.key} row={row} people={shownPeople} color={color} cellIndex={cellIndex} selection={selection} marks={marks}
                pick={pick} onOpen={openRole} onFold={toggleFold} />;
            }
            if (row.type === 'others') return <OthersRow key={row.key} count={row.count} span={span} />;
            return <ResourceRow key={row.key} row={row} people={shownPeople} roles={roles} color={color} cellIndex={cellIndex} selection={selection} marks={marks}
              ctx={ctx} inCandidate={candidate.entitlements.has(row.col.id)} onCell={onCell} onResource={onResource} />;
          })}
          {padBottom > 0 && <tr aria-hidden="true"><td colSpan={span} style={{ height: padBottom, padding: 0, border: 'none' }} /></tr>}
    </PageStickyTable>
  );
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// "2 entitlements", "2 entitlements · 1 hidden by filters", "(all hidden by filters)".
function roleCount(row) {
  if (row.allHidden) return '(all hidden by filters)';
  const hidden = row.hidden > 0 && !row.role.draft ? ` · ${row.hidden} hidden by filters` : '';
  return `${plural(row.count, 'entitlement', 'entitlements')}${hidden}`;
}

// A business role of the band: its colour, its name (opens it in the panel), how
// many entitlements are under it (fold), and who holds it — or, for a proposed
// role, who it is for — in each person's column.
function RoleRow({ row, people, color, cellIndex, selection, marks, pick, onOpen, onFold }) {
  const { role } = row;
  const bg = color(role.idx);
  return (
    <tr style={{ height: ROW_HEIGHT }} data-role={role.id}>
      <th scope="row" colSpan={2} className={`${STICKY_NAME} px-1 text-left font-semibold`} style={{ backgroundColor: bg }}>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => onFold(role.id)} aria-expanded={!row.folded} aria-label={`${row.folded ? 'Unfold' : 'Fold'} ${role.displayName}`}
            className="w-4 shrink-0 text-gray-700 dark:text-gray-900">{row.folded ? '▸' : '▾'}</button>
          <button type="button" onClick={() => onOpen(role.id)} title={`${role.displayName} — open in the panel`} className="min-w-0 truncate text-left text-gray-900 hover:underline">
            {role.displayName}
          </button>
          <span className="ml-auto shrink-0 text-[10px] font-normal text-gray-700">{roleCount(row)}</span>
        </div>
      </th>
      <td colSpan={2} className={`${CELL} ${STUCK} text-gray-700 dark:text-gray-300`} style={{ backgroundColor: bg, left: LEFT_AT[2] }}>{role.draft ? 'Proposed role' : 'Business role'}</td>
      <td className={`${CELL} ${STUCK} text-right text-gray-700 dark:text-gray-300`} style={{ backgroundColor: bg, left: LEFT_AT[4] }}>{role.holders.size}</td>
      {people.map(person => (
        <RoleCell key={person.key} role={role} personKey={person.key} cellIndex={cellIndex} color={color} selection={selection} marks={marks} pick={pick} />
      ))}
    </tr>
  );
}

function OthersRow({ count, span }) {
  return (
    <tr style={{ height: ROW_HEIGHT }}>
      <th scope="rowgroup" colSpan={span} className="sticky left-0 border-b border-t border-gray-200 bg-gray-100 px-2 text-left text-xs font-semibold text-gray-800 dark:border-gray-700 dark:bg-gray-900/80 dark:text-gray-100">
        Other access <span className="font-normal text-gray-600 dark:text-gray-400">· {count} not in any role shown</span>
      </th>
    </tr>
  );
}

// The contexts a resource belongs to, as the matrix's Contexts cell shows them: the first two, then "+N".
function ContextsCell({ ids, ctx }) {
  const names = (ids || []).map(id => ctx.byId.get(String(id))?.displayName ?? String(id));
  const all = (ids || []).map(id => ctx.label(id)).join('\n');
  return (
    <td className={`${CELL} ${STUCK} ${ROW_BG} text-gray-700 dark:text-gray-300`} style={{ left: LEFT_AT[1] }} title={all || undefined}>
      {names.slice(0, 2).join(', ')}{names.length > 2 ? ` +${names.length - 2}` : ''}
    </td>
  );
}

// An entitlement: under the role that contains it (its colour on the left edge), or
// under Other access. Click its name to select what the people shown hold of it. A
// proposed role's entitlement the filters would hide still shows, marked.
function ResourceRow({ row, people, roles, color, cellIndex, selection, marks, ctx, inCandidate, onCell, onResource }) {
  const { col, role } = row;
  const title = [col.displayName, col.resourceType, col.systemName, plural(col.holders, 'person', 'people')].filter(Boolean).join(' · ');
  const name = inCandidate ? 'bg-emerald-50 dark:bg-emerald-900/30' : 'bg-white dark:bg-gray-800';
  return (
    <tr style={{ height: ROW_HEIGHT }} className={row.hiddenByFilter ? 'opacity-60' : undefined} data-hidden-by-filter={row.hiddenByFilter || undefined}>
      <th scope="row" className={`${STICKY_NAME} ${name} px-1 text-left font-normal`} style={role ? { borderLeft: `6px solid ${color(role.idx)}` } : undefined}>
        <div className={`flex min-w-0 items-center gap-1 ${role ? 'pl-3' : ''}`}>
          <button type="button" onClick={(e) => onResource(col, e)} title={title} aria-label={`Select the row ${title}`}
            className="min-w-0 truncate text-left text-gray-800 hover:underline dark:text-gray-100">{col.displayName}</button>
          {row.hiddenByFilter && <span className="shrink-0 rounded bg-gray-200 px-1 text-[9px] text-gray-700 dark:bg-gray-700 dark:text-gray-200">hidden by filter</span>}
        </div>
      </th>
      <ContextsCell ids={col.contexts} ctx={ctx} />
      <td className={`${CELL} ${STUCK} ${ROW_BG} text-gray-600 dark:text-gray-400`} style={{ left: LEFT_AT[2] }}>{col.resourceType}</td>
      <td className={`${CELL} ${STUCK} ${ROW_BG} text-gray-600 dark:text-gray-400`} style={{ left: LEFT_AT[3] }}>{col.systemName}</td>
      <td className={`${CELL} ${STUCK} ${ROW_BG} text-right text-gray-700 dark:text-gray-300`} style={{ left: LEFT_AT[4] }}>{col.holders}</td>
      {people.map((person, p) => {
        const k = cellKey(person.key, col.id);
        const props = cellProps({ cell: cellIndex.get(k), personKey: person.key, resourceId: col.id, roles, color });
        return (
          <MatrixCell key={person.key} cellKey={k} {...props} selected={selection.has(k)} label={cellLabel(props, marks.get(k))} onSelect={(e) => onCell(p, col.id, e)}>
            <MarkSign mark={marks.get(k)} />
          </MatrixCell>
        );
      })}
    </tr>
  );
}
