import { useTreeResolve, adjustTabTitle } from './useTreeResolve';

// The "Adjust tree" entry point: an item in a tree's ⋯ menu and in a unit's
// header ⋯ menu. It asks the API which tree the context belongs to; when it
// can be adjusted it opens its Adjust tree tab (`onOpen(treeKey, title)`),
// otherwise it stays visible but disabled, with the reason beside it. It
// stays focusable while disabled (aria-disabled), so the reason can be read.

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
      {reason && <span className="block text-xs text-gray-600 dark:text-gray-400">{reason}</span>}
    </button>
  );
}
