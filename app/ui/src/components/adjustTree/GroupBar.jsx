import { useState } from 'react';
import { GroupForm } from './UnitActionForms';
import { commonParentId, indexUnits } from './adjustTree.helpers';

// Shown above the tree once units are picked with their checkboxes: how many,
// "Group into new unit…" (a new unit with the picked units moved under it —
// the quick way to give a flat list of units a level) and Clear.

const BTN = 'rounded border border-gray-300 bg-white px-2.5 py-1 text-sm font-medium text-blue-700 hover:bg-blue-50 dark:border-gray-600 dark:bg-gray-800 dark:text-blue-300 dark:hover:bg-blue-900/30';

export default function GroupBar({ checked, units, onGroup, onClear }) {
  const [open, setOpen] = useState(false);
  if (checked.size === 0) return null;
  const ids = [...checked];
  const parentId = commonParentId(units, ids);
  const parentName = parentId != null ? indexUnits(units).get(parentId)?.name : null;

  async function group(name, reason) {
    if (await onGroup({ name, parentId, unitIds: ids, reason })) { setOpen(false); onClear(); }
  }

  return (
    <div className="space-y-2 rounded-lg border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <span>{ids.length} unit{ids.length === 1 ? '' : 's'} picked</span>
        <button type="button" aria-pressed={open} onClick={() => setOpen(o => !o)} className={BTN}>Group into new unit…</button>
        <button type="button" onClick={onClear} className={BTN}>Clear</button>
      </div>
      {open && <GroupForm count={ids.length} parentName={parentName} onGroup={group} />}
    </div>
  );
}
