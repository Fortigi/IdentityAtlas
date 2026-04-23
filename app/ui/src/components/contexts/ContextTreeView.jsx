import { useState } from 'react';
import { variantMeta, targetTypeMeta } from '../../utils/contextStyles';

// Recursive tree renderer. Each node is a rounded pill with a variant-colored
// bubble; connector lines between parent and child make the hierarchy
// obvious at a glance. Every pill is a button so keyboard navigation still
// works — aria-expanded stays on the expander toggle.

const INDENT_PX = 22;  // horizontal offset per depth level
const CONNECTOR = 'rgb(203 213 225)'; // slate-300 — matches the bubble ring

export default function ContextTreeView({ nodes, onOpenDetail }) {
  return (
    <div className="p-4">
      <ul className="text-sm space-y-1">
        {nodes.map(n => (
          <TreeNode key={n.id} node={n} depth={0} isLast={true} onOpenDetail={onOpenDetail} />
        ))}
      </ul>
    </div>
  );
}

function TreeNode({ node, depth, isLast, onOpenDetail }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = node.children && node.children.length > 0;
  const v = variantMeta(node.variant);
  const t = targetTypeMeta(node.targetType);

  return (
    <li className="relative">
      {/* Horizontal connector: L-shaped line from the parent's vertical stem
          into this node's bubble. Only drawn when the node isn't a top-level root. */}
      {depth > 0 && (
        <span
          aria-hidden="true"
          className="absolute"
          style={{
            left: `${(depth - 1) * INDENT_PX + 10}px`,
            top: 0,
            bottom: isLast ? '50%' : 0,
            width: `${INDENT_PX - 2}px`,
            borderLeft: `1px solid ${CONNECTOR}`,
            borderBottom: `1px solid ${CONNECTOR}`,
            borderBottomLeftRadius: '6px',
          }}
        />
      )}

      <div
        className="flex items-center gap-2"
        style={{ paddingLeft: `${depth * INDENT_PX}px` }}
      >
        {hasChildren ? (
          <button
            aria-expanded={expanded}
            onClick={() => setExpanded(prev => !prev)}
            className="w-5 h-5 flex items-center justify-center text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 dark:bg-gray-700 rounded shrink-0"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-5 h-5 inline-block shrink-0" />
        )}

        <button
          onClick={() => onOpenDetail(node.id, node.displayName)}
          className="flex items-center gap-2 min-w-0 px-3 py-1.5 rounded-full border border-slate-200 dark:border-gray-600 bg-white dark:bg-gray-800 hover:bg-slate-50 dark:bg-gray-700/50 hover:border-slate-300 dark:border-gray-500 hover:shadow-sm transition-shadow text-left shrink max-w-full"
        >
          <span
            className={`w-2.5 h-2.5 rounded-full ${v.dotClass} ring-2 ring-white outline outline-1 outline-slate-200 shrink-0`}
            aria-hidden="true"
          />
          <span className="font-medium text-gray-900 dark:text-white truncate">{node.displayName}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${t.badgeClass} whitespace-nowrap shrink-0`}>
            {t.label}
          </span>
          <MemberCount direct={node.directMemberCount} total={node.totalMemberCount} />
        </button>
      </div>

      {hasChildren && expanded && (
        <ul className="space-y-1 mt-1">
          {node.children.map((c, i) => (
            <TreeNode
              key={c.id}
              node={c}
              depth={depth + 1}
              isLast={i === node.children.length - 1}
              onOpenDetail={onOpenDetail}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// Shows "<direct> direct" for leaves and "<direct> · <total>" for subtree
// nodes so the weight carried under an expanded node is obvious at a glance.
function MemberCount({ direct, total }) {
  if (typeof direct !== 'number' && typeof total !== 'number') return null;
  const d = direct || 0;
  const t = total  || 0;
  if (t > d) {
    return (
      <span className="text-[11px] text-gray-400 dark:text-gray-500 whitespace-nowrap shrink-0">
        {d} · <span className="text-gray-600 dark:text-gray-400 dark:text-gray-500">{t}</span>
      </span>
    );
  }
  return <span className="text-[11px] text-gray-400 dark:text-gray-500 whitespace-nowrap shrink-0">{d}</span>;
}
