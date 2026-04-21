import { useState } from 'react';
import { variantMeta, targetTypeMeta } from '../../utils/contextStyles';

// Recursive tree renderer. Every node is a button (keyboard-accessible).
// aria-expanded set on parents. onOpenDetail opens the Context Detail tab.

export default function ContextTreeView({ nodes, onOpenDetail }) {
  return (
    <div className="p-3">
      <ul className="text-sm">
        {nodes.map(n => <TreeNode key={n.id} node={n} depth={0} onOpenDetail={onOpenDetail} />)}
      </ul>
    </div>
  );
}

function TreeNode({ node, depth, onOpenDetail }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = node.children && node.children.length > 0;
  const v = variantMeta(node.variant);
  const t = targetTypeMeta(node.targetType);

  return (
    <li>
      <div
        className="flex items-center gap-1 py-1 pr-2 hover:bg-gray-50 rounded group"
        style={{ paddingLeft: `${depth * 16}px` }}
      >
        {hasChildren ? (
          <button
            aria-expanded={expanded}
            onClick={() => setExpanded(prev => !prev)}
            className="w-5 h-5 flex items-center justify-center text-gray-500 hover:bg-gray-100 rounded"
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-5 h-5 inline-block" />
        )}

        <span className={`inline-block w-1 h-5 ${v.dotClass} rounded`} aria-hidden="true" />

        <button
          onClick={() => onOpenDetail(node.id, node.displayName)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          <span className="font-medium text-gray-900 truncate">{node.displayName}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${t.badgeClass} whitespace-nowrap`}>{t.label}</span>
          <MemberCount direct={node.directMemberCount} total={node.totalMemberCount} />
        </button>
      </div>
      {hasChildren && expanded && (
        <ul>
          {node.children.map(c => (
            <TreeNode key={c.id} node={c} depth={depth + 1} onOpenDetail={onOpenDetail} />
          ))}
        </ul>
      )}
    </li>
  );
}

// Shows "<direct> direct" when the node is a leaf or direct == total,
// "<direct> direct · <total> total" otherwise so analysts can eyeball how
// much weight a subtree carries without expanding it.
function MemberCount({ direct, total }) {
  if (typeof direct !== 'number' && typeof total !== 'number') return null;
  const d = direct || 0;
  const t = total  || 0;
  if (t > d) {
    return (
      <span className="text-[11px] text-gray-400 whitespace-nowrap">
        {d} direct · <span className="text-gray-600">{t} total</span>
      </span>
    );
  }
  return <span className="text-[11px] text-gray-400 whitespace-nowrap">{d} direct</span>;
}
