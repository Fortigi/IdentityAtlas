import { useState } from 'react';
import { actionAllowed } from './adjustTree.helpers';

// The Needs attention tab: what the API found worth a look — adjustments that
// need a decision or no longer apply, the source agreeing with a change, split
// candidates, people not placed — each with its one-click fix. Only "select"
// (show me the unit) is offered to a reader; the fixes change the tree.

const TONE = {
  bad: 'border-l-red-600 dark:border-l-red-400',
  warn: 'border-l-amber-600 dark:border-l-amber-400',
  ok: 'border-l-green-600 dark:border-l-green-400',
};

const BUTTON = 'rounded border border-gray-300 bg-white px-2.5 py-1 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-blue-300 dark:hover:bg-blue-900/30';

export default function AttentionPanel({ items, editable, onAction }) {
  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold text-gray-900 dark:text-white">Needs attention</h2>
      {items.length === 0
        ? <p className="text-sm text-gray-600 dark:text-gray-400">Nothing left to review. The tree and its adjustments are consistent.</p>
        : (
          <ul className="space-y-2">
            {items.map(item => <AttentionItem key={item.id} item={item} editable={editable} onAction={onAction} />)}
          </ul>
        )}
    </div>
  );
}

function AttentionItem({ item, editable, onAction }) {
  const [busy, setBusy] = useState(false);
  const { action } = item;
  async function run() {
    setBusy(true);
    try { await onAction(action, item); } finally { setBusy(false); }
  }
  return (
    <li className={`space-y-1.5 rounded-lg border border-l-[3px] border-gray-200 px-3 py-2 dark:border-gray-700 ${TONE[item.severity] || TONE.warn}`}>
      <p className="text-sm font-medium text-gray-900 dark:text-white">{item.title}</p>
      {item.detail && <p className="text-sm text-gray-600 dark:text-gray-400">{item.detail}</p>}
      {actionAllowed(action, editable) && (
        <button type="button" onClick={run} disabled={busy} className={BUTTON}>{action.label}</button>
      )}
    </li>
  );
}
