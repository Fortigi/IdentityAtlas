import { useState } from 'react';
import { HeaderControls } from './PeopleCells';
import { PERMISSION_COLUMNS, distinctPermissionValues } from './workbench.permissions';

// ─── Filtering the permissions shown ─────────────────────────────────────
// The same Excel-like filter and sort the people have, on Resource name, Contexts
// (only these / hide resources in these — a context takes its sub-contexts), Type,
// System and Held by (workbench.permissions.js). With people as columns they head
// the access rows (PermissionHeaderCells); with people as rows they sit behind a
// "Permissions" menu in the toolbar (PermissionsMenu). `perms` is
// { allAccess, ctx, filters, sort, onSort, onFilter } from the page.

function Controls({ pcol, perms, open, onOpenChange }) {
  return (
    <HeaderControls column={pcol} values={distinctPermissionValues(perms.allAccess, pcol, perms.ctx)} filter={perms.filters[pcol.key]}
      sort={perms.sort} onSort={perms.onSort} onFilter={perms.onFilter} open={open} onOpenChange={onOpenChange} />
  );
}

/** One header cell per permission column, above the access rows (people as columns). */
export function PermissionHeaderCells({ perms, widths }) {
  const [open, setOpen] = useState(null);
  return PERMISSION_COLUMNS.map((pcol, i) => (
    <th key={pcol.key} scope="col" data-sticky-left style={{ width: widths[i], zIndex: open === pcol.key ? 50 : 30, left: i === 0 ? 0 : undefined }}
      className={`${i === 0 ? 'sticky' : 'relative'} border-b border-r border-gray-200 bg-gray-50 px-1 py-1 text-left text-[11px] font-semibold text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200`}>
      <Controls pcol={pcol} perms={perms} open={open === pcol.key} onOpenChange={(v) => setOpen(v ? pcol.key : null)} />
    </th>
  ));
}

/** "Permissions ▾": the same filters as a menu (people as rows, where the permissions are columns). */
export function PermissionsMenu({ perms }) {
  const [shown, setShown] = useState(false);
  const [open, setOpen] = useState(null);
  const active = Object.values(perms.filters || {}).filter(Boolean).length;
  return (
    <div className="relative">
      <button type="button" onClick={() => setShown(s => !s)} aria-expanded={shown}
        className={`rounded border px-2 py-0.5 text-xs ${active ? 'border-blue-600 bg-blue-600 text-white dark:bg-blue-500' : 'border-gray-300 text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-700'}`}>
        Permissions{active ? ` (${active})` : ''} ▾
      </button>
      {shown && (
        <div role="dialog" aria-label="Filter the permissions" className="absolute left-0 top-full z-50 mt-1 w-72 rounded-md border border-gray-200 bg-white p-2 text-xs shadow-lg dark:border-gray-600 dark:bg-gray-800">
          <ul className="space-y-1">
            {PERMISSION_COLUMNS.map(pcol => (
              <li key={pcol.key} className="text-gray-800 dark:text-gray-100">
                <Controls pcol={pcol} perms={perms} open={open === pcol.key} onOpenChange={(v) => setOpen(v ? pcol.key : null)} />
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => setShown(false)} className="mt-1 text-blue-700 hover:underline dark:text-blue-300">Done</button>
        </div>
      )}
    </div>
  );
}

/** "12 of 251 permissions shown", the active permission filters (× each), and Clear. Nothing without a filter. */
export function PermissionStrip({ shown, total, summary, onClear, onClearAll }) {
  if (summary.length === 0 && shown === total) return null;
  return (
    <div role="region" aria-label="Permission filters" className="flex flex-wrap items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
      <span className="font-semibold text-gray-900 dark:text-gray-100">{shown} of {total} permissions shown</span>
      {summary.map(s => (
        <span key={s.key} className="inline-flex items-center gap-1 rounded bg-blue-50 px-1.5 py-0.5 text-blue-900 dark:bg-blue-900/40 dark:text-blue-100">
          {s.text}
          <button type="button" onClick={() => onClear(s.key)} aria-label={`Clear the ${s.text.split(':')[0]} filter`} className="hover:text-red-600">✕</button>
        </span>
      ))}
      {summary.length > 0 && <button type="button" onClick={onClearAll} className="text-blue-700 hover:underline dark:text-blue-300">Clear permission filters</button>}
    </div>
  );
}
