import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useAuth } from '../auth/AuthGate';
import { TIER_STYLES } from '../utils/tierStyles';
import { useDebouncedValue } from '../hooks/useDebouncedValue';

// ─── Constants ───────────────────────────────────────────────────────────────

const TIER_ORDER = { Critical: 5, High: 4, Medium: 3, Low: 2, Minimal: 1, None: 0 };
const TIER_DISPLAY = ['Critical', 'High', 'Medium', 'Low', 'Minimal'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeDeptRisk(members) {
  const tierCounts = {};
  let scoreSum = 0;
  let scoreCount = 0;
  let maxSeverity = 0;
  let maxTier = 'None';

  for (const person of members) {
    const tier = person.riskTier || 'None';
    tierCounts[tier] = (tierCounts[tier] || 0) + 1;
    if (person.riskScore != null) {
      scoreSum += person.riskScore;
      scoreCount++;
    }
    const severity = TIER_ORDER[tier] || 0;
    if (severity > maxSeverity) {
      maxSeverity = severity;
      maxTier = tier;
    }
  }

  return {
    maxTier,
    avgScore: scoreCount > 0 ? Math.round(scoreSum / scoreCount) : 0,
    tierCounts,
    totalPeople: members.length,
  };
}

// ─── Small components ────────────────────────────────────────────────────────

function TierBadge({ tier, showAll }) {
  if (!showAll && (!tier || tier === 'None' || tier === 'Minimal')) return null;
  const s = TIER_STYLES[tier] || TIER_STYLES.None;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${s.bg} ${s.text} ${s.border} border whitespace-nowrap`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {tier}
    </span>
  );
}

function Avatar({ name, tier }) {
  const letter = (name || '?')[0].toUpperCase();
  const style = TIER_STYLES[tier] || TIER_STYLES.None;
  return (
    <div
      className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0"
      style={{ backgroundColor: style.avatar }}
    >
      {letter}
    </div>
  );
}

// ─── Department box (the clickable card in the flowchart) ────────────────────

function DeptBox({ node, isMatch, onClick, onDetails, hasChildren }) {
  const s = TIER_STYLES[node.risk.maxTier] || TIER_STYLES.None;
  const direct = node.directCount || node.risk.totalPeople;
  const indirect = node.indirectCount || 0;

  return (
    <div className="relative min-w-[150px] max-w-[220px]">
      <button
        onClick={() => onDetails(node.id)}
        className={`w-full border-2 rounded-lg px-4 py-3 transition-all cursor-pointer text-center hover:shadow-md ${
          isMatch ? 'ring-2 ring-blue-400' : ''
        }`}
        style={{
          backgroundColor: node.isContext ? '#f0f9ff' : s.box,
          borderColor: node.isContext ? '#bae6fd' : s.boxBorder,
        }}
      >
        <div className="font-semibold text-sm text-gray-900 leading-tight">
          {node.department}
        </div>
        {node.isContext && node.contextType && (
          <div className="text-[9px] text-sky-600 mt-0.5">{node.contextType}</div>
        )}
        {node.isContext && node.managerDisplayName && (
          <div className="text-[10px] text-gray-500 mt-0.5 truncate">{node.managerDisplayName}</div>
        )}
        <div className="text-[10px] text-gray-500 mt-1">
          {direct} direct{indirect > 0 && <span className="text-gray-400"> | {indirect} indirect</span>}
        </div>

        {/* Risk badge top-right */}
        {node.risk.maxTier && node.risk.maxTier !== 'None' && (
          <div className="absolute -top-2.5 -right-2">
            <TierBadge tier={node.risk.maxTier} showAll />
          </div>
        )}
      </button>

      {/* Expand/collapse toggle below the box */}
      {hasChildren && (
        <div className="text-center mt-0.5">
          <button
            onClick={(e) => { e.stopPropagation(); onClick(); }}
            className="text-[10px] text-blue-500 hover:text-blue-700 hover:underline"
          >
            expand
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Recursive org chart node with hybrid layout ─────────────────────────────
// Depth 0 (root): horizontal flowchart with connector lines
// Depth 1+: vertical indented tree (prevents horizontal overflow)

function OrgNode({ node, depth, onDetails, expandedMap, toggleExpand, matchNodeIds }) {
  const isExpanded = expandedMap[node.id] ?? false;
  const hasChildren = node.children.length > 0;
  const useVertical = depth >= 1;

  // Sort children by member count descending (biggest departments first = left-to-right)
  const sortedChildren = useMemo(() =>
    [...node.children].sort((a, b) => {
      const aCount = a.directCount || a.risk?.totalPeople || a.memberCount || 0;
      const bCount = b.directCount || b.risk?.totalPeople || b.memberCount || 0;
      return bCount - aCount;
    }),
    [node.children]
  );

  // ── Vertical tree layout (depth >= 1) ───────────────────────
  if (useVertical) {
    return (
      <div>
        <DeptBox
          node={node}
          isMatch={matchNodeIds && matchNodeIds.has(node.id)}
          onClick={() => { if (hasChildren) toggleExpand(node.id); }}
          onDetails={onDetails}
          hasChildren={hasChildren}
        />

        {hasChildren && !isExpanded && (
          <button
            onClick={() => toggleExpand(node.id)}
            className="mt-1 ml-4 text-[10px] text-blue-600 hover:text-blue-800 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5"
          >
            +{sortedChildren.length} sub-dept{sortedChildren.length !== 1 ? 's' : ''}
          </button>
        )}

        {hasChildren && isExpanded && (
          <div className="ml-8 mt-2 space-y-0">
            {sortedChildren.map((child, i) => {
              const isLast = i === sortedChildren.length - 1;
              return (
                <div key={child.id} className="relative pl-6">
                  {/* Vertical line running down from top; stops at connector for last child */}
                  <div
                    className="absolute left-0 top-0 w-0 border-l-2 border-gray-300"
                    style={{ height: isLast ? '20px' : '100%' }}
                  />
                  {/* Horizontal connector from vertical line to box */}
                  <div className="absolute left-0 top-5 w-6 border-t-2 border-gray-300" />
                  <div className="pb-2">
                    <OrgNode
                      node={child}
                      depth={depth + 1}
                      onDetails={onDetails}
                      expandedMap={expandedMap}
                      toggleExpand={toggleExpand}
                      matchNodeIds={matchNodeIds}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ── Horizontal flowchart layout (depth 0 — root) ───────────
  return (
    <div className="flex flex-col items-center">
      <DeptBox
        node={node}
        isMatch={matchNodeIds && matchNodeIds.has(node.id)}
        onClick={() => { if (hasChildren) toggleExpand(node.id); }}
        onDetails={onDetails}
        hasChildren={hasChildren}
      />

      {hasChildren && isExpanded && (
        <>
          {/* Vertical stem down from parent */}
          <div className="w-0.5 h-6 bg-gray-300" />

          {/* Children row — sorted by member count descending (biggest left) */}
          <div className="flex justify-center">
            {sortedChildren.map((child, i) => {
              const isFirst = i === 0;
              const isLast = i === sortedChildren.length - 1;
              const isSingle = sortedChildren.length === 1;

              return (
                <div key={child.id} className="flex flex-col items-center shrink-0">
                  {/* Connector: horizontal bar edge-to-edge (no padding so adjacent segments connect) */}
                  <div className="flex w-full h-5">
                    <div className={`flex-1 ${!isFirst && !isSingle ? 'border-t-2 border-gray-300' : ''}`} />
                    <div className="w-0.5 bg-gray-300" />
                    <div className={`flex-1 ${!isLast && !isSingle ? 'border-t-2 border-gray-300' : ''}`} />
                  </div>

                  {/* Recurse — padding here so boxes have spacing but connectors touch */}
                  <div className="px-3">
                    <OrgNode
                      node={child}
                      depth={depth + 1}
                      onDetails={onDetails}
                      expandedMap={expandedMap}
                      toggleExpand={toggleExpand}
                      matchNodeIds={matchNodeIds}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function OrgChartPage({ onOpenDetail, onCacheData }) {
  const { authFetch } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search.trim().toLowerCase(), 250);
  const [expandedMap, setExpandedMap] = useState({});
  const initialExpandDone = useRef(false);

  // ─── Context-based tree (preferred when available) ────────────────
  const [contextTree, setContextTree] = useState(null);
  const [useContexts, setUseContexts] = useState(false);

  // ─── Fetch data ──────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Try Contexts tree first (faster, pre-built hierarchy)
      try {
        const ctxRes = await authFetch('/api/contexts/tree');
        if (ctxRes.ok) {
          const ctxData = await ctxRes.json();
          if (ctxData && ctxData.length > 0) {
            setContextTree(ctxData);
            setUseContexts(true);
            setData({ available: true });
            return;
          }
        }
      } catch { /* Contexts not available, fall through to user-based tree */ }

      // Fall back to user-based org chart
      const res = await authFetch('/api/org-chart');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.available === false) {
        setData({ available: false, message: json.message || 'Org chart data not available.' });
      } else {
        setData(json);
      }
    } catch (err) {
      console.error('Failed to load org chart:', err);
      setError(err.message || 'Failed to load org chart data');
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ─── Build department tree ──────────────────────────────────────
  const { rootNode, nodeMap } = useMemo(() => {
    if (!data || data.available === false) {
      return { rootNode: null, nodeMap: new Map(), totalUsers: 0, totalDepts: 0 };
    }

    // ── Context-based tree (preferred) ──────────────────────────────
    if (useContexts && contextTree && contextTree.length > 0) {
      const nMap = new Map();

      function convertContextNode(ctx) {
        const node = {
          id: ctx.id,
          department: ctx.displayName,
          contextType: ctx.contextType,
          managerDisplayName: ctx.managerDisplayName,
          members: [], // members are loaded on-demand via detail page
          children: (ctx.children || []).map(convertContextNode),
          risk: { maxTier: 'None', avgScore: 0, tierCounts: {}, totalPeople: ctx.memberCount || 0 },
          directCount: ctx.memberCount || 0,
          indirectCount: (ctx.totalMemberCount || 0) - (ctx.memberCount || 0),
          subtreeCount: ctx.totalMemberCount || ctx.memberCount || 0,
          isContext: true,
        };
        nMap.set(node.id, node);
        return node;
      }

      const convertedRoots = contextTree.map(convertContextNode);

      // If multiple roots, wrap in a synthetic root
      let root;
      if (convertedRoots.length === 1) {
        root = convertedRoots[0];
      } else {
        const totalMembers = convertedRoots.reduce((sum, r) => sum + (r.subtreeCount || 0), 0);
        root = {
          id: 'context-root',
          department: 'Organization',
          members: [],
          children: convertedRoots,
          risk: { maxTier: 'None', avgScore: 0, tierCounts: {}, totalPeople: totalMembers },
          directCount: 0,
          indirectCount: totalMembers,
          subtreeCount: totalMembers,
          isContext: true,
        };
        nMap.set(root.id, root);
      }

      return { rootNode: root, nodeMap: nMap, totalUsers: root.subtreeCount, totalDepts: nMap.size };
    }

    // ── User-based tree (fallback) ──────────────────────────────────
    const users = data.users || [];
    const userMap = new Map();
    const childrenMap = new Map(); // userId -> [direct report users]

    for (const u of users) userMap.set(u.id, u);

    for (const u of users) {
      if (u.managerId && userMap.has(u.managerId)) {
        if (!childrenMap.has(u.managerId)) childrenMap.set(u.managerId, []);
        childrenMap.get(u.managerId).push(u);
      }
    }

    // Find single root: user with no manager (or manager not in dataset) + most total reports
    let bestRoot = null;
    let bestCount = -1;
    for (const u of users) {
      const hasNoManager = !u.managerId || !userMap.has(u.managerId);
      const reports = childrenMap.get(u.id);
      if (!hasNoManager || !reports || reports.length === 0) continue;

      const totalReports = u.riskHierarchyTotalReports || reports.length;
      if (totalReports > bestCount) {
        bestCount = totalReports;
        bestRoot = u;
      }
    }

    if (!bestRoot) {
      return { rootNode: null, nodeMap: new Map(), totalUsers: 0, totalDepts: 0 };
    }

    // Build department tree with de-duplication by department name
    const visited = new Set();
    const nMap = new Map(); // nodeId -> node (for detail lookup)
    let nodeCounter = 0;
    let deptCount = 0;

    function buildChildren(parentMembers, parentDeptName) {
      // Collect all direct reports of all parent members
      const allReports = [];
      for (const member of parentMembers) {
        const reports = childrenMap.get(member.id) || [];
        for (const r of reports) {
          if (!visited.has(r.id)) {
            allReports.push(r);
            visited.add(r.id);
          }
        }
      }

      // Group by department name → de-duplicate
      const deptGroups = new Map();
      for (const report of allReports) {
        const dept = report.department || '(No department)';
        if (!deptGroups.has(dept)) deptGroups.set(dept, []);
        deptGroups.get(dept).push(report);
      }

      const children = [];
      const mergedMembers = []; // members from same-name child depts rolled into parent

      for (const [deptName, deptMembers] of deptGroups) {
        deptMembers.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));

        if (deptName === parentDeptName) {
          // Same department name as parent — roll up: merge members into parent, promote grandchildren
          mergedMembers.push(...deptMembers);
          const sub = buildChildren(deptMembers, parentDeptName);
          mergedMembers.push(...sub.mergedMembers);
          children.push(...sub.nodes);
          continue;
        }

        const sub = buildChildren(deptMembers, deptName);
        const allDeptMembers = [...deptMembers, ...sub.mergedMembers];
        const nodeId = `dept-${++nodeCounter}`;
        deptCount++;

        const node = {
          id: nodeId,
          department: deptName,
          members: allDeptMembers,
          children: sub.nodes,
          risk: computeDeptRisk(allDeptMembers),
        };
        nMap.set(nodeId, node);
        children.push(node);
      }

      // Sort: highest risk first, then by member count
      children.sort((a, b) => {
        const riskDiff = (TIER_ORDER[b.risk.maxTier] || 0) - (TIER_ORDER[a.risk.maxTier] || 0);
        if (riskDiff !== 0) return riskDiff;
        return b.risk.totalPeople - a.risk.totalPeople;
      });

      return { nodes: children, mergedMembers };
    }

    visited.add(bestRoot.id);
    const rootDeptName = bestRoot.department || '(No department)';
    const rootResult = buildChildren([bestRoot], rootDeptName);
    const rootMembers = [bestRoot, ...rootResult.mergedMembers];

    // Count all people in a subtree (members + all descendants) and store on node
    function countSubtreePeople(node) {
      let indirect = 0;
      for (const child of node.children) indirect += countSubtreePeople(child);
      node.directCount = node.members.length;
      node.indirectCount = indirect;
      node.subtreeCount = node.members.length + indirect;
      return node.subtreeCount;
    }

    // Sort root children by total subtree size (largest left)
    for (const child of rootResult.nodes) {
      countSubtreePeople(child);
    }
    rootResult.nodes.sort((a, b) => b.subtreeCount - a.subtreeCount);

    // Cap at MAX_TOP_DEPTS, merge rest into "Other"
    const MAX_TOP_DEPTS = 8;
    let topChildren = rootResult.nodes;

    if (topChildren.length > MAX_TOP_DEPTS) {
      const top = topChildren.slice(0, MAX_TOP_DEPTS);
      const rest = topChildren.slice(MAX_TOP_DEPTS);

      function collectAllPeople(node) {
        let all = [...node.members];
        for (const child of node.children) all.push(...collectAllPeople(child));
        return all;
      }
      const allOtherPeople = [];
      for (const r of rest) allOtherPeople.push(...collectAllPeople(r));

      const otherId = `dept-other`;
      deptCount++;
      const otherNode = {
        id: otherId,
        department: `Other (${rest.length} depts)`,
        members: [],
        children: rest,
        risk: computeDeptRisk(allOtherPeople),
      };
      nMap.set(otherId, otherNode);
      topChildren = [...top, otherNode];
    }

    const rootId = `dept-root`;
    deptCount++;

    const root = {
      id: rootId,
      department: rootDeptName,
      members: rootMembers,
      children: topChildren,
      risk: computeDeptRisk(rootMembers),
    };
    countSubtreePeople(root);
    nMap.set(rootId, root);

    return {
      rootNode: root,
      nodeMap: nMap,
      totalUsers: visited.size,
      totalDepts: deptCount,
    };
  }, [data, useContexts, contextTree]);

  // ─── Initial expand: only root ─────────────────────────────────
  useEffect(() => {
    if (rootNode && !initialExpandDone.current) {
      initialExpandDone.current = true;
      setExpandedMap({ [rootNode.id]: true });
    }
  }, [rootNode]);

  // ─── Search matching ───────────────────────────────────────────
  const { matchNodeIds, matchCount } = useMemo(() => {
    if (!debouncedSearch || !rootNode) {
      return { matchNodeIds: new Set(), matchCount: 0 };
    }

    const nodeMatches = new Set();
    let userMatchCount = 0;

    function walkNodes(node) {
      let matched = false;
      // Check department name
      if ((node.department || '').toLowerCase().includes(debouncedSearch)) {
        matched = true;
      }
      // Check members
      for (const member of node.members) {
        const hay = [member.displayName, member.jobTitle, member.department]
          .filter(Boolean).join(' ').toLowerCase();
        if (hay.includes(debouncedSearch)) {
          matched = true;
          userMatchCount++;
        }
      }
      if (matched) nodeMatches.add(node.id);

      for (const child of node.children) walkNodes(child);
    }
    walkNodes(rootNode);

    return { matchNodeIds: nodeMatches, matchCount: userMatchCount };
  }, [debouncedSearch, rootNode]);

  // ─── Expand / collapse ─────────────────────────────────────────
  const toggleExpand = useCallback((id) => {
    setExpandedMap(prev => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const expandAll = useCallback(() => {
    if (!rootNode) return;
    const map = {};
    function walk(node) {
      map[node.id] = true;
      for (const child of node.children) walk(child);
    }
    walk(rootNode);
    setExpandedMap(map);
  }, [rootNode]);

  const collapseAll = useCallback(() => {
    if (!rootNode) return;
    setExpandedMap({ [rootNode.id]: true });
  }, [rootNode]);

  // ─── Open department/orgunit detail as tab ──────────────────────
  const openDeptDetail = useCallback((nodeId) => {
    const node = nodeMap.get(nodeId);
    if (!node) return;

    if (node.isOrgUnit) {
      // OrgUnit: open orgunit detail tab
      if (onCacheData) {
        onCacheData(node.id, 'orgunit', { node });
      }
      onOpenDetail('orgunit', node.id, node.department);
    } else {
      // Legacy department: cache the node data so DepartmentDetailPage can use it
      if (onCacheData) {
        onCacheData(node.department, 'department', { node });
      }
      onOpenDetail('department', node.department, node.department);
    }
  }, [nodeMap, onCacheData, onOpenDetail]);

  // ─── Render ───────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading org chart data...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6 max-w-md mx-auto mt-12">
        <h2 className="text-red-800 font-semibold text-lg">Failed to load org chart</h2>
        <p className="text-red-600 mt-2 text-sm">{error}</p>
        <button onClick={fetchData} className="mt-3 text-sm text-red-700 underline hover:text-red-900">Retry</button>
      </div>
    );
  }

  if (data && data.available === false) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 max-w-lg mx-auto mt-12">
        <h2 className="text-amber-800 font-semibold text-lg">Org Chart Not Available</h2>
        <p className="text-amber-700 mt-2 text-sm">
          {data.message || 'User data with manager information is required.'}
        </p>
      </div>
    );
  }

  if (!rootNode) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-gray-400 text-sm">
        No users with manager data found. Run a sync that includes manager information first.
      </div>
    );
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="bg-white border border-gray-200 rounded-lg px-4 py-3 mb-4 flex items-center gap-4 flex-wrap">
        <div className="flex-1 min-w-[200px] max-w-sm">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, title, or department..."
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
            aria-label="Search org chart"
          />
        </div>
        <div className="flex items-center gap-1">
          <button onClick={expandAll} className="text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded px-2 py-1 hover:bg-gray-50">
            Expand All
          </button>
          <button onClick={collapseAll} className="text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded px-2 py-1 hover:bg-gray-50">
            Collapse All
          </button>
        </div>
        {debouncedSearch && (
          <div className="text-xs text-gray-400">
            {matchCount} match{matchCount !== 1 ? 'es' : ''} in {matchNodeIds.size} department{matchNodeIds.size !== 1 ? 's' : ''}
          </div>
        )}
      </div>

      {/* Org chart */}
      <div className="bg-white border border-gray-200 rounded-lg p-6 overflow-x-auto">
        <div className="flex justify-center py-4">
          <OrgNode
            node={rootNode}
            depth={0}
            onDetails={openDeptDetail}
            expandedMap={expandedMap}
            toggleExpand={toggleExpand}
            matchNodeIds={matchNodeIds}
          />
        </div>
      </div>
    </div>
  );
}
