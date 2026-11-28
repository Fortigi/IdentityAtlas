// A context owner's navigation: the same tree as the Contexts page, holding only
// what they are Accountable or Responsible for and the sub-units below it
// (useOwnerTree.js). Read-only: selecting is all it does. It opens on the direct
// sub-units. Above each tree, in a light colour, the units it sits under: names
// for orientation, not links, because they are outside the owner's scope.
//
// On the Role portfolios tab it also lists the business roles they answer for
// whose portfolio they do not hold (ownerPortfolios.js): each under that
// portfolio's name, in the same light colour, or under "Default portfolio".

import { useMemo } from 'react';
import { useReviewRequests } from '@ui/contexts/ReviewRequestsContext';
import ContextTreeView from '@ui/components/contexts/ContextTreeView';
import RoleBadge from './RoleBadge';

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

// One portfolio they do not hold, by name only, and their roles in it.
function PortfolioRoles({ group, selectedRoleId, onSelectRole }) {
  // The roles a review campaign asks them to review carry a mark.
  const { requests } = useReviewRequests();
  const waiting = new Set(requests.map(q => String(q.roleId).toLowerCase()));
  return (
    <div className="mb-3">
      <AncestorTrail names={[group.name]} />
      <ul aria-label={`Your business roles in ${group.name}`} style={{ marginLeft: indent(1) }} className="space-y-0.5">
        {group.roles.map(r => (
          <li key={r.id}>
            <button type="button" onClick={() => onSelectRole(r)} aria-current={r.id === selectedRoleId ? 'true' : undefined}
              className={`w-full text-left flex items-center justify-between gap-2 rounded px-2 py-1 text-sm ${r.id === selectedRoleId
                ? 'bg-blue-50 text-blue-900 dark:bg-blue-900/30 dark:text-blue-100'
                : 'text-gray-800 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700'}`}>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{r.displayName || r.id}</span>
                {waiting.has(String(r.id).toLowerCase()) && (
                  <span data-testid="review-waiting" title="A review is waiting for you" className="shrink-0 rounded-full border border-amber-400 bg-amber-100 px-1.5 text-[11px] font-medium text-amber-900 dark:border-amber-600 dark:bg-amber-900/40 dark:text-amber-100">Review</span>
                )}
              </span>
              <RoleBadge role={r.role} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function OwnerTreePane({ nodes, selectedId, onSelect, roleGroups = [], selectedRoleId = null, onSelectRole }) {
  return (
    <nav aria-label="What you answer for" className="w-96 shrink-0 overflow-y-auto border-r border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
      {nodes.map(root => <OwnerRootTree key={root.id} root={root} selectedId={selectedId} onSelect={onSelect} />)}
      {roleGroups.map(g => <PortfolioRoles key={g.key} group={g} selectedRoleId={selectedRoleId} onSelectRole={onSelectRole} />)}
    </nav>
  );
}
