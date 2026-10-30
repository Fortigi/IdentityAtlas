import { useTreeResolve, adjustTabTitle } from './useTreeResolve';

// The "Adjust tree" entry points: an item in a tree's ⋯ menu, and a button in
// a unit's header. Both ask the API which tree the context belongs to; when it
// can be adjusted they open its Adjust tree tab (`onOpen(treeKey, title)`),
// otherwise they stay visible but disabled, with the reason beside them. They
// stay focusable while disabled (aria-disabled), so the reason can be read.

export function AdjustTreeMenuItem({ contextId, className, autoFocus, onOpen, onDone }) {
  const { tree, state, reason } = useTreeResolve(contextId, true);
  const ready = state === 'ready';
  return (
    <button
      type="button" role="menuitem" data-autofocus={autoFocus || undefined}
      aria-disabled={!ready || undefined}
      onClick={() => { if (!ready) return; onDone?.(); onOpen(tree.treeKey, adjustTabTitle(tree.name)); }}
      title={ready ? 'Correct this tree: move, split, rename units and set managers' : reason || undefined}
      className={`${className} ${ready ? 'text-gray-800 dark:text-gray-200' : 'cursor-default text-gray-600 dark:text-gray-400'}`}
    >
      {state === 'loading' ? 'Adjust tree…' : 'Adjust tree'}
      {reason && <span className="block text-[11px] text-gray-600 dark:text-gray-400">{reason}</span>}
    </button>
  );
}

const BTN = 'rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium whitespace-nowrap dark:border-gray-600 dark:bg-gray-800';

export function AdjustTreeButton({ contextId, onOpen }) {
  const { tree, state, reason } = useTreeResolve(contextId, true);
  // Nothing to offer while unknown, or when the check itself failed.
  if (state === 'loading' || state === 'failed') return null;
  const ready = state === 'ready';
  return (
    <span className="inline-flex flex-col items-end">
      <button
        type="button" aria-disabled={!ready || undefined}
        onClick={() => { if (ready) onOpen(tree.treeKey, adjustTabTitle(tree.name)); }}
        title={ready ? 'Correct this tree on a full-width screen' : reason}
        className={`${BTN} ${ready
          ? 'text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-900/30'
          : 'cursor-default text-gray-600 dark:text-gray-400'}`}
      >Adjust tree</button>
      {!ready && <span className="mt-0.5 max-w-[16rem] text-right text-[11px] text-gray-600 dark:text-gray-400">{reason}</span>}
    </span>
  );
}
