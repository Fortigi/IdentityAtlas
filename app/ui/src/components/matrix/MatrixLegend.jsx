import { useState } from 'react';
import { TYPE_COLORS } from '@ui/utils/colors';

// On-screen key for the matrix. The grid encodes everything as single colored
// letters (D/I/E/O), AP-tinted backgrounds, a count bubble, and a gap marker —
// none of which is explained anywhere in the app (the only legend used to live
// inside the Excel export). This renders that key inline, reusing the exact
// TYPE_COLORS swatches the cells use so it can never drift.

// The matrix shows only HOW access is held. Source-attribute types collapse
// onto these in MatrixView (business role / OAuth2 grant / direct app role →
// Direct; app role via group → Indirect), so the legend only lists the three
// real badges. Ownership is no longer a badge — it is its own resource
// (resourceType='GroupOwnership') shown as a normal row. Whether access is
// governed is shown by the cell colour below.
const TYPE_LABELS = [
  ['Direct', 'Direct membership'],
  ['Indirect', 'Indirect (via a nested resource)'],
  ['Eligible', 'Eligible — just-in-time access'],
];

function Badge({ type }) {
  const c = TYPE_COLORS[type];
  if (!c) return null;
  return (
    <span
      className="inline-block w-4 h-4 rounded-sm text-center text-[9px] leading-4 font-bold shrink-0"
      style={{ backgroundColor: c.bg, color: c.text }}
      aria-hidden="true"
    >
      {c.letter}
    </span>
  );
}

const STORAGE_KEY = 'matrixLegendCollapsed';

export default function MatrixLegend() {
  // Default open so first-time users can read the grid; persist the choice.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
  });

  const toggle = () => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-xs">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded-lg"
      >
        <span className="text-gray-500 dark:text-gray-400" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        How to read this matrix
      </button>

      {!collapsed && (
        <div className="flex flex-col gap-3 px-3 pb-3 pt-1">
          {/* Membership-type badges */}
          <div>
            <div className="mb-1 text-gray-500 dark:text-gray-400">Cell badges — how the access is held</div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
              {TYPE_LABELS.map(([type, label]) => (
                <div key={type} className="flex items-center gap-1.5">
                  <Badge type={type} />
                  <span className="text-gray-700 dark:text-gray-300">{label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Background / markers */}
          <div className="flex flex-col gap-1 border-t border-gray-100 dark:border-gray-700 pt-2">
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-4 h-4 rounded-sm border border-gray-300 dark:border-gray-600 shrink-0" style={{ backgroundColor: '#fde68a' }} aria-hidden="true" />
              <span className="text-gray-700 dark:text-gray-300">
                Coloured cell = membership is <span className="font-medium">governed</span> by a business role / access package (the colour matches its column).
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="inline-flex w-4 h-4 items-center justify-center rounded-full bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-500 text-[8px] font-bold shrink-0" aria-hidden="true">2</span>
              <span className="text-gray-700 dark:text-gray-300">Covered by more than one business role (the number shows how many).</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="inline-flex w-4 h-4 items-center justify-center rounded-full bg-amber-500 text-white border border-amber-600 text-[8px] font-bold shrink-0" aria-hidden="true">!</span>
              <span className="text-gray-700 dark:text-gray-300">
                <span className="font-medium">Provisioning gap</span> — a business role expects this membership but the user doesn&apos;t have it.
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
