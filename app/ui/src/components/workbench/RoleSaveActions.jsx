import { useState } from 'react';
import { defaultInvestigationName, roleIsSaved } from './workbench.save';

// ─── Save the role ───────────────────────────────────────────────────────
// At the end of the active proposed role: "Save role" saves the investigation
// (every role, as the top strip's Save does) once this role has what it needs (a
// name, its kind, an entitlement — the panel lists what is missing); "Save and
// start the next role" also clears the selection and opens a new role, its kind
// still to choose, filters and columns kept. A first save asks the investigation's
// name here, prefilled "<unit> — dd-mm-yyyy".

export default function RoleSaveActions({ inv, candidate, problems, unitName, dispatch }) {
  const [name, setName] = useState(() => defaultInvestigationName(unitName));
  // A refusal shows here only for a save made here (the top strip shows its own).
  const [tried, setTried] = useState(false);
  const blocked = inv.busy || problems.length > 0 || (!inv.saved && !name.trim());
  // This role as saved (its hand-chosen members, not the ones its rule computes).
  const saved = roleIsSaved(inv.saved, { ...candidate, members: candidate.handMembers ?? candidate.members });

  const save = async (next) => {
    setTried(true);
    const ok = inv.saved ? (inv.dirty ? await inv.save() : true) : await inv.saveAs(name.trim());
    if (ok && next) dispatch({ type: 'startNext' });
  };

  return (
    <div className="space-y-2" aria-label="Save the role" role="group">
      {!inv.saved && (
        <label className="block text-xs text-gray-700 dark:text-gray-300">
          Save the investigation as
          <input value={name} onChange={e => setName(e.target.value)} aria-label="Save the investigation as"
            className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={blocked} onClick={() => save(false)}
          className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-500">Save role</button>
        <button type="button" disabled={blocked} onClick={() => save(true)}
          className="rounded border border-blue-600 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-400 dark:text-blue-300 dark:hover:bg-blue-900/30">Save and start the next role</button>
        {saved && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">Saved</span>}
      </div>
      {tried && inv.error && <p role="alert" className="text-xs text-red-700 dark:text-red-300">{inv.error}</p>}
    </div>
  );
}
