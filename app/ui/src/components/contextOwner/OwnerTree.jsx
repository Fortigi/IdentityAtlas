// A context owner's navigation: the same tree as the Contexts page, holding only
// what they are Accountable or Responsible for and the sub-units below it
// (useOwnerTree.js). Read-only: selecting is all it does. It opens on the direct
// sub-units. Above each tree, in a light colour, the units it sits under: names
// for orientation, not links, because they are outside the owner's scope.

import { useMemo } from 'react';
import ContextTreeView from '@ui/components/contexts/ContextTreeView';

const STEP_PX = 14;
const MAX_STEPS = 5;
const indent = level => Math.min(level, MAX_STEPS) * STEP_PX;

function AncestorTrail({ names }) {
  if (!names.length) return null;
  return (
    <ol aria-label="Part of" className="mb-1 space-y-0.5">
      {names.map((name, i) => (
        <li key={`${i}-${name}`} style={{ marginLeft: indent(i) }}
          className="truncate border-l border-dashed border-gray-300 py-0.5 pl-2 text-xs text-gray-500 dark:border-gray-600 dark:text-gray-400">
          {name}
        </li>
      ))}
    </ol>
  );
}

function OwnerRootTree({ root, selectedId, onSelect }) {
  // One stable list: the tree re-seeds whenever its `nodes` change identity.
  const nodes = useMemo(() => [root], [root]);
  const names = root.ancestors || [];
  return (
    <div className="mb-3">
      <AncestorTrail names={names} />
      <div style={{ marginLeft: indent(names.length) }}>
        <ContextTreeView nodes={nodes} selectedId={selectedId} onSelect={onSelect} openLevels={1} />
      </div>
    </div>
  );
}

export default function OwnerTreePane({ nodes, selectedId, onSelect }) {
  return (
    <nav aria-label="What you answer for" className="w-96 shrink-0 overflow-y-auto border-r border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
      {nodes.map(root => <OwnerRootTree key={root.id} root={root} selectedId={selectedId} onSelect={onSelect} />)}
    </nav>
  );
}
