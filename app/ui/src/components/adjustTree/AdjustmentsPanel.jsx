import { useState } from 'react';
import { byLine, statusMeta } from './adjustTree.helpers';

// The Adjustments tab: every change made on top of the tree from the source,
// newest first (the API's order), with its status, who made it, when and why.
// Undo takes one change back and the tree is rebuilt without it; Redo puts an
// undone change back. A change that needs a decision shows the API's
// suggestion with Follow (point it there) and Remove.

const PILL = {
  ok: 'bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300',
  warn: 'bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-300',
  bad: 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300',
  neutral: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};
const LINK = 'rounded px-1.5 py-0.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:text-blue-300 dark:hover:bg-blue-900/30';

export default function AdjustmentsPanel({ adjustments, editable, onUndo, onRedo, onFollow }) {
  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold text-gray-900 dark:text-white">Adjustments</h2>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        Every change made on top of the tree from the source. They are applied again after every refresh. Undo removes one change, and the tree is rebuilt without it.
      </p>
      {adjustments.length === 0
        ? <p className="text-sm text-gray-600 dark:text-gray-400">No adjustments yet. This tree is exactly as the source has it.</p>
        : (
          <ul className="divide-y divide-gray-200 dark:divide-gray-700">
            {adjustments.map(a => <Entry key={a.id} adj={a} editable={editable} onUndo={onUndo} onRedo={onRedo} onFollow={onFollow} />)}
          </ul>
        )}
    </div>
  );
}

function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = (fn) => async () => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };
  return { busy, run };
}

function Entry({ adj, editable, onUndo, onRedo, onFollow }) {
  const { busy, run } = useBusy();
  const meta = statusMeta(adj.status);
  const reverted = adj.status === 'reverted';
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 py-2">
      <p className={`text-sm font-medium ${reverted ? 'text-gray-600 line-through dark:text-gray-400' : 'text-gray-900 dark:text-white'}`}>{adj.description}</p>
      <div className="row-span-3 flex flex-col items-end gap-1">
        <span className={`whitespace-nowrap rounded-full px-2 text-xs leading-5 ${PILL[meta.tone]}`}>{meta.label}</span>
        {editable && (reverted
          ? <button type="button" disabled={busy} onClick={run(() => onRedo(adj))} className={LINK} aria-label={`Redo: ${adj.description}`}>Redo</button>
          : <button type="button" disabled={busy} onClick={run(() => onUndo(adj))} className={LINK} aria-label={`Undo: ${adj.description}`}>Undo</button>)}
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        {byLine(adj)}{adj.reason && <> · “{adj.reason}”</>}
      </p>
      {adj.statusDetail && !reverted && <p className="text-xs text-gray-600 dark:text-gray-400">{adj.statusDetail}</p>}
      {adj.status === 'needsDecision' && adj.suggestion && (
        <Decision adj={adj} editable={editable} busy={busy} run={run} onFollow={onFollow} onUndo={onUndo} />
      )}
    </li>
  );
}

function Decision({ adj, editable, busy, run, onFollow, onUndo }) {
  return (
    <div className="col-span-2 mt-1 flex flex-wrap items-center gap-2 rounded bg-amber-50 px-2 py-1.5 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
      <span>Suggested: <span className="font-medium">{adj.suggestion.name}</span></span>
      {editable && (
        <>
          <button type="button" disabled={busy} onClick={run(() => onFollow(adj))} className={LINK}>Follow</button>
          <button type="button" disabled={busy} onClick={run(() => onUndo(adj))} className={LINK}>Remove</button>
        </>
      )}
    </div>
  );
}
