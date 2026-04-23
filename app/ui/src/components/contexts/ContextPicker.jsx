import { useEffect, useMemo, useState, useCallback } from 'react';
import { useAuth } from '../../auth/AuthGate';
import { Modal, SecondaryButton } from './ModalPrimitives';
import { variantMeta, targetTypeMeta } from '../../utils/contextStyles';

// ─── ContextPicker ────────────────────────────────────────────────────────────
// Reusable modal for selecting a single Context. Mirrors the look of
// ContextTreeView (rounded pills, variant bubbles, connector lines) and
// the search/toggle layout of ContextListView.
//
// Used by:
//   - ManualContextEditor — picking a parent context
//   - matrix/ContextFilterControl — picking a context to filter the matrix on
//
// Props:
//   open          boolean — controls visibility
//   onClose       fn — called for cancel / backdrop click
//   onPick        fn(node) — called with the selected node, then onClose
//   value         string | null — currently-selected id (for visual highlight)
//   targetType    string | null — restrict to roots whose targetType matches
//   excludeIds    Set<string> | string[] — these ids and all their descendants are hidden
//   title         string — modal title (default: "Pick a context")
//   subtitle      string — optional helper text below the title

const INDENT_PX = 22;
const CONNECTOR = 'rgb(203 213 225)';

export default function ContextPicker({
  open,
  onClose,
  onPick,
  value = null,
  targetType = null,
  excludeIds = null,
  title = 'Pick a context',
  subtitle,
}) {
  const { authFetch } = useAuth();
  const [trees, setTrees] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [view, setView] = useState('tree');
  const [expanded, setExpanded] = useState(() => new Set());

  // Normalise excludeIds → Set for O(1) lookups.
  const excludeSet = useMemo(() => {
    if (!excludeIds) return new Set();
    if (excludeIds instanceof Set) return excludeIds;
    return new Set(excludeIds);
  }, [excludeIds]);

  // Fetch the full tree on open. /api/contexts/tree returns every Context
  // nested under their root, so one request gives us everything we need.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setError(null);
    authFetch('/api/contexts/tree')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(roots => {
        if (cancelled) return;
        setTrees(Array.isArray(roots) ? roots : []);
        // Auto-expand top level only on open.
        const auto = new Set();
        for (const r of roots || []) auto.add(r.id);
        setExpanded(auto);
      })
      .catch(err => { if (!cancelled) setError(err.message || 'Failed to load contexts'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, authFetch]);

  // Reset transient state when the modal closes.
  useEffect(() => {
    if (!open) {
      setSearch('');
      setView('tree');
    }
  }, [open]);

  // Apply targetType + excludeIds filters AND prune subtrees rooted at
  // excluded ids. Returns a new tree.
  const filteredTrees = useMemo(() => {
    function prune(nodes) {
      const out = [];
      for (const n of nodes || []) {
        if (excludeSet.has(n.id)) continue;
        const children = n.children?.length ? prune(n.children) : [];
        out.push({ ...n, children });
      }
      return out;
    }
    let result = prune(trees);
    if (targetType) {
      // The DB enforces same targetType throughout a tree, so root-level
      // filter is sufficient.
      result = result.filter(r => r.targetType === targetType);
    }
    return result;
  }, [trees, targetType, excludeSet]);

  // Apply search. In tree mode we keep the structure but only show paths
  // that contain matches. In list mode we filter the flat result.
  const matchedSet = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    const matched = new Set();
    function walk(nodes) {
      for (const n of nodes) {
        const matches = (n.displayName || '').toLowerCase().includes(q);
        const childMatches = n.children?.length ? walk(n.children) : false;
        if (matches || childMatches) matched.add(n.id);
      }
      return [...nodes].some(n => matched.has(n.id));
    }
    walk(filteredTrees);
    return matched;
  }, [filteredTrees, search]);

  // When searching, auto-expand every node on a matching path so matches
  // are visible. Triggered on each search-string change.
  useEffect(() => {
    if (!matchedSet) return;
    setExpanded(prev => {
      const next = new Set(prev);
      for (const id of matchedSet) next.add(id);
      return next;
    });
  }, [matchedSet]);

  const flat = useMemo(() => {
    if (view !== 'list') return [];
    const out = [];
    function walk(nodes, depth) {
      for (const n of nodes) {
        if (matchedSet && !matchedSet.has(n.id)) continue;
        out.push({ ...n, _depth: depth });
        if (n.children?.length) walk(n.children, depth + 1);
      }
    }
    walk(filteredTrees, 0);
    return out;
  }, [view, filteredTrees, matchedSet]);

  const toggleExpand = useCallback((id) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  function handlePick(node) {
    onPick?.(node);
    onClose?.();
  }

  if (!open) return null;

  return (
    <Modal
      title={title}
      subtitle={subtitle || (targetType ? `Showing ${targetType}-targeted contexts.` : null)}
      onClose={onClose}
      width={680}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-3">
        <input
          autoFocus
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search contexts…"
          className="flex-1 px-2 py-1 border border-gray-200 dark:border-gray-700 rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-sky-400 dark:focus:ring-sky-500"
        />
        <div className="flex items-center bg-gray-100 dark:bg-gray-700 rounded p-0.5">
          <button
            onClick={() => setView('tree')}
            className={`px-2 py-0.5 text-xs rounded ${view === 'tree' ? 'bg-white dark:bg-gray-800 shadow-sm text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-400'}`}
          >Tree</button>
          <button
            onClick={() => setView('list')}
            className={`px-2 py-0.5 text-xs rounded ${view === 'list' ? 'bg-white dark:bg-gray-800 shadow-sm text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-400'}`}
          >List</button>
        </div>
      </div>

      {/* Body */}
      <div className="border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 max-h-[60vh] overflow-auto p-3">
        {loading && <div className="text-xs text-gray-500 dark:text-gray-400">Loading…</div>}
        {error && <div className="text-xs text-red-700 dark:text-red-400">{error}</div>}
        {!loading && !error && filteredTrees.length === 0 && (
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {targetType
              ? `No ${targetType}-targeted contexts available.`
              : 'No contexts available.'}
          </div>
        )}
        {!loading && !error && filteredTrees.length > 0 && view === 'tree' && (
          <ul className="text-sm space-y-1">
            {filteredTrees.map(n => (
              <PickerNode
                key={n.id}
                node={n}
                depth={0}
                isLast={true}
                expanded={expanded}
                onToggleExpand={toggleExpand}
                matchedSet={matchedSet}
                value={value}
                onPick={handlePick}
              />
            ))}
          </ul>
        )}
        {!loading && !error && filteredTrees.length > 0 && view === 'list' && (
          <ul className="text-sm divide-y divide-gray-100 dark:divide-gray-700">
            {flat.map(n => (
              <PickerListRow key={n.id} node={n} value={value} onPick={handlePick} />
            ))}
            {flat.length === 0 && (
              <li className="text-xs text-gray-500 dark:text-gray-400 px-2 py-2">No matches.</li>
            )}
          </ul>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <span className="text-[11px] text-gray-500 dark:text-gray-400">
          Click a node to select. Currently shown: {countNodes(filteredTrees, matchedSet)}
        </span>
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
      </div>
    </Modal>
  );
}

// ─── Tree mode: recursive node ────────────────────────────────────────────────
function PickerNode({ node, depth, isLast, expanded, onToggleExpand, matchedSet, value, onPick }) {
  // Hide branches that have no matches under search.
  if (matchedSet && !matchedSet.has(node.id)) return null;
  const hasChildren = node.children && node.children.some(c => !matchedSet || matchedSet.has(c.id));
  const isOpen = expanded.has(node.id) || !!matchedSet;
  const v = variantMeta(node.variant);
  const t = targetTypeMeta(node.targetType);
  const isSelected = value === node.id;

  return (
    <li className="relative">
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

      <div className="flex items-center gap-2" style={{ paddingLeft: `${depth * INDENT_PX}px` }}>
        {hasChildren ? (
          <button
            aria-expanded={isOpen}
            onClick={() => onToggleExpand(node.id)}
            className="w-5 h-5 flex items-center justify-center text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded shrink-0"
            title={isOpen ? 'Collapse' : 'Expand'}
          >
            {isOpen ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-5 h-5 inline-block shrink-0" />
        )}

        <button
          onClick={() => onPick(node)}
          className={`flex items-center gap-2 min-w-0 px-3 py-1.5 rounded-full border text-left shrink max-w-full transition-shadow ${
            isSelected
              ? 'border-sky-400 dark:border-sky-500 bg-sky-50 dark:bg-sky-900/30 text-gray-900 dark:text-white shadow-sm'
              : 'border-slate-200 dark:border-gray-600 bg-white dark:bg-gray-800 hover:bg-slate-50 dark:hover:bg-gray-700/50 hover:border-slate-300 dark:hover:border-gray-500 hover:shadow-sm'
          }`}
        >
          <span
            className={`w-2.5 h-2.5 rounded-full ${v.dotClass} ring-2 ring-white dark:ring-gray-800 outline outline-1 outline-slate-200 dark:outline-gray-600 shrink-0`}
            aria-hidden="true"
          />
          <span className="font-medium text-gray-900 dark:text-white truncate">{node.displayName}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${t.badgeClass} whitespace-nowrap shrink-0`}>{t.label}</span>
          {node.contextType && (
            <span className="text-[10px] text-gray-400 dark:text-gray-500 whitespace-nowrap shrink-0">{node.contextType}</span>
          )}
          <MemberCount direct={node.directMemberCount} total={node.totalMemberCount} />
        </button>
      </div>

      {hasChildren && isOpen && (
        <ul className="space-y-1 mt-1">
          {node.children.map((c, i) => (
            <PickerNode
              key={c.id}
              node={c}
              depth={depth + 1}
              isLast={i === node.children.length - 1}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              matchedSet={matchedSet}
              value={value}
              onPick={onPick}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// ─── List mode: flat row ─────────────────────────────────────────────────────
function PickerListRow({ node, value, onPick }) {
  const v = variantMeta(node.variant);
  const t = targetTypeMeta(node.targetType);
  const isSelected = value === node.id;
  return (
    <li>
      <button
        onClick={() => onPick(node)}
        className={`w-full text-left flex items-center gap-2 px-2 py-1.5 transition-colors ${
          isSelected
            ? 'bg-sky-50 dark:bg-sky-900/30'
            : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
        }`}
      >
        <span style={{ paddingLeft: `${node._depth * 16}px` }} className="inline-block" />
        <span className={`w-2 h-2 rounded-full ${v.dotClass} shrink-0`} aria-hidden="true" />
        <span className="font-medium text-gray-900 dark:text-white truncate flex-1 min-w-0">{node.displayName}</span>
        <span className="text-[10px] text-gray-400 dark:text-gray-500 whitespace-nowrap">{node.contextType}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${t.badgeClass} whitespace-nowrap`}>{t.label}</span>
        <MemberCount direct={node.directMemberCount} total={node.totalMemberCount} />
      </button>
    </li>
  );
}

function MemberCount({ direct, total }) {
  if (typeof direct !== 'number' && typeof total !== 'number') return null;
  const d = direct || 0;
  const t = total  || 0;
  if (t > d) {
    return (
      <span className="text-[11px] text-gray-400 dark:text-gray-500 whitespace-nowrap shrink-0">
        {d} · <span className="text-gray-600 dark:text-gray-400">{t}</span>
      </span>
    );
  }
  return <span className="text-[11px] text-gray-400 dark:text-gray-500 whitespace-nowrap shrink-0">{d}</span>;
}

// Counts visible nodes after filters / search.
function countNodes(trees, matchedSet) {
  let n = 0;
  function walk(nodes) {
    for (const node of nodes) {
      if (matchedSet && !matchedSet.has(node.id)) continue;
      n++;
      if (node.children?.length) walk(node.children);
    }
  }
  walk(trees);
  return n;
}
