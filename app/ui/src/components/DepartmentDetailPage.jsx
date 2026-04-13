import { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '../auth/AuthGate';
import { TIER_STYLES } from '../utils/tierStyles';

// ─── Constants ───────────────────────────────────────────────────────────────

const TIER_ORDER = { Critical: 5, High: 4, Medium: 3, Low: 2, Minimal: 1, None: 0 };
const TIER_DISPLAY = ['Critical', 'High', 'Medium', 'Low', 'Minimal'];
const TIER_BAR_COLORS = {
  Critical: '#ef4444', High: '#f97316', Medium: '#eab308', Low: '#3b82f6', Minimal: '#9ca3af', None: '#e5e7eb',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeRisk(members) {
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

function collectAllMembers(node) {
  let all = [];
  for (const member of node.members) {
    all.push({ ...member, _dept: node.department });
  }
  for (const child of node.children) {
    all.push(...collectAllMembers(child));
  }
  return all;
}

function collectSubDepts(node, depth = 0) {
  const depts = [];
  for (const child of node.children) {
    depts.push({ name: child.department, directCount: child.directCount || child.members.length, depth });
    depts.push(...collectSubDepts(child, depth + 1));
  }
  return depts;
}

// ─── Build department tree from flat user list (for refresh/no-cache case) ───

function buildDeptTree(users, targetDeptName) {
  const userMap = new Map();
  const childrenMap = new Map();
  for (const u of users) userMap.set(u.id, u);
  for (const u of users) {
    if (u.managerId && userMap.has(u.managerId)) {
      if (!childrenMap.has(u.managerId)) childrenMap.set(u.managerId, []);
      childrenMap.get(u.managerId).push(u);
    }
  }

  // Find root
  let bestRoot = null;
  let bestCount = -1;
  for (const u of users) {
    const hasNoManager = !u.managerId || !userMap.has(u.managerId);
    const reports = childrenMap.get(u.id);
    if (!hasNoManager || !reports || reports.length === 0) continue;
    const total = u.riskHierarchyTotalReports || reports.length;
    if (total > bestCount) { bestCount = total; bestRoot = u; }
  }
  if (!bestRoot) return null;

  const visited = new Set();

  function buildChildren(parentMembers, parentDeptName) {
    const allReports = [];
    for (const member of parentMembers) {
      for (const r of (childrenMap.get(member.id) || [])) {
        if (!visited.has(r.id)) { allReports.push(r); visited.add(r.id); }
      }
    }
    const deptGroups = new Map();
    for (const report of allReports) {
      const dept = report.department || '(No department)';
      if (!deptGroups.has(dept)) deptGroups.set(dept, []);
      deptGroups.get(dept).push(report);
    }
    const children = [];
    const mergedMembers = [];
    for (const [deptName, deptMembers] of deptGroups) {
      if (deptName === parentDeptName) {
        mergedMembers.push(...deptMembers);
        const sub = buildChildren(deptMembers, parentDeptName);
        mergedMembers.push(...sub.mergedMembers);
        children.push(...sub.nodes);
        continue;
      }
      const sub = buildChildren(deptMembers, deptName);
      const allDeptMembers = [...deptMembers, ...sub.mergedMembers];
      children.push({ department: deptName, members: allDeptMembers, children: sub.nodes, risk: computeRisk(allDeptMembers) });
    }
    return { nodes: children, mergedMembers };
  }

  visited.add(bestRoot.id);
  const rootDeptName = bestRoot.department || '(No department)';
  const rootResult = buildChildren([bestRoot], rootDeptName);

  // Count subtree
  function countSubtree(node) {
    let indirect = 0;
    for (const child of node.children) indirect += countSubtree(child);
    node.directCount = node.members.length;
    node.indirectCount = indirect;
    node.subtreeCount = node.members.length + indirect;
    return node.subtreeCount;
  }

  // Find the target department in the tree
  function findDept(nodes, name) {
    for (const n of nodes) {
      if (n.department === name) return n;
      const found = findDept(n.children, name);
      if (found) return found;
    }
    return null;
  }

  const rootNode = { department: rootDeptName, members: [bestRoot, ...rootResult.mergedMembers], children: rootResult.nodes, risk: computeRisk([bestRoot, ...rootResult.mergedMembers]) };
  countSubtree(rootNode);

  if (rootNode.department === targetDeptName) return rootNode;
  return findDept(rootResult.nodes, targetDeptName);
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

// ─── Risk summary section ────────────────────────────────────────────────────

function buildSummaryText(directMembers, allMembers, directRisk, allRisk, node) {
  const parts = [];
  const direct = directMembers.length;
  const total = allMembers.length;
  const scored = allMembers.filter(m => m.riskScore != null);

  if (scored.length === 0) return 'No risk score data available for this department.';

  // Tier breakdown sentence
  const tierParts = TIER_DISPLAY
    .filter(t => allRisk.tierCounts[t] > 0)
    .map(t => `${allRisk.tierCounts[t]} ${t.toLowerCase()}`);
  if (tierParts.length > 0) {
    const pct = Math.round((scored.length / total) * 100);
    parts.push(`Of ${total} total member${total !== 1 ? 's' : ''} (${direct} direct${total > direct ? `, ${total - direct} indirect` : ''}), ${pct === 100 ? 'all have' : `${scored.length} have`} risk scores: ${tierParts.join(', ')}.`);
  }

  // Highest risk tier explanation
  const highTiers = TIER_DISPLAY.filter(t => (TIER_ORDER[t] || 0) >= 3 && allRisk.tierCounts[t] > 0);
  if (highTiers.length > 0) {
    const highCount = highTiers.reduce((sum, t) => sum + (allRisk.tierCounts[t] || 0), 0);
    const highPct = Math.round((highCount / scored.length) * 100);
    parts.push(`${highCount} member${highCount !== 1 ? 's' : ''} (${highPct}%) are rated medium or above, which drives the department's overall ${allRisk.maxTier.toLowerCase()} risk classification.`);
  } else {
    parts.push(`No members are rated medium risk or above. The department's risk posture is ${allRisk.maxTier.toLowerCase()}.`);
  }

  // Score spread
  const scores = scored.map(m => m.riskScore);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (min !== max) {
    parts.push(`Scores range from ${min} to ${max} (avg ${allRisk.avgScore}).`);
  }

  return parts.join(' ');
}

function RiskSummary({ directMembers, allMembers, directRisk, allRisk, subDepts, node, onOpenDetail }) {
  const scored = allMembers.filter(m => m.riskScore != null);
  if (scored.length === 0) return null;

  // Score stats
  const scores = scored.map(m => m.riskScore).sort((a, b) => a - b);
  const min = scores[0];
  const max = scores[scores.length - 1];
  const median = scores.length % 2 === 0
    ? Math.round((scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2)
    : scores[Math.floor(scores.length / 2)];

  // Top 5 highest risk members
  const topRisk = [...scored].sort((a, b) => b.riskScore - a.riskScore).slice(0, 5);

  // Tier distribution for bar
  const allTiers = [...TIER_DISPLAY, 'None'];
  const tierSegments = allTiers
    .map(t => ({ tier: t, count: allRisk.tierCounts[t] || 0 }))
    .filter(s => s.count > 0);
  const totalScored = scored.length;

  const summaryText = buildSummaryText(directMembers, allMembers, directRisk, allRisk, node);

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
      <div className="px-6 py-3 border-b border-gray-100 bg-gray-50">
        <h3 className="text-sm font-semibold text-gray-700">Risk Summary</h3>
      </div>

      <div className="px-6 py-4 space-y-4">
        {/* Text explanation */}
        <p className="text-sm text-gray-600 leading-relaxed">{summaryText}</p>

        {/* Distribution bar */}
        <div>
          <div className="text-xs text-gray-500 mb-1.5">Risk distribution</div>
          <div className="flex h-6 rounded-md overflow-hidden border border-gray-200">
            {tierSegments.map(s => {
              const pct = (s.count / totalScored) * 100;
              return (
                <div
                  key={s.tier}
                  className="flex items-center justify-center text-[10px] font-medium text-white transition-all"
                  style={{ width: `${pct}%`, backgroundColor: TIER_BAR_COLORS[s.tier], minWidth: pct > 0 ? '18px' : 0 }}
                  title={`${s.tier}: ${s.count} (${Math.round(pct)}%)`}
                >
                  {pct >= 10 ? s.count : ''}
                </div>
              );
            })}
          </div>
          <div className="flex gap-3 mt-1.5">
            {tierSegments.map(s => (
              <div key={s.tier} className="flex items-center gap-1 text-[10px] text-gray-500">
                <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: TIER_BAR_COLORS[s.tier] }} />
                {s.tier} ({s.count})
              </div>
            ))}
          </div>
        </div>

        {/* Stats + Top risk in two columns */}
        <div className="grid grid-cols-2 gap-4">
          {/* Score stats */}
          <div>
            <div className="text-xs text-gray-500 mb-2">Score statistics</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {[
                { label: 'Average', value: allRisk.avgScore },
                { label: 'Median', value: median },
                { label: 'Lowest', value: min },
                { label: 'Highest', value: max },
                { label: 'Scored', value: `${scored.length} / ${allMembers.length}` },
              ].map(s => (
                <div key={s.label} className="flex justify-between text-xs py-0.5">
                  <span className="text-gray-400">{s.label}</span>
                  <span className="font-mono text-gray-700">{s.value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Top risk contributors */}
          <div>
            <div className="text-xs text-gray-500 mb-2">Highest risk members</div>
            <div className="space-y-1">
              {topRisk.map(user => (
                <div key={user.id} className="flex items-center gap-2 text-xs">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: TIER_BAR_COLORS[user.riskTier || 'None'] }} />
                  <button
                    onClick={() => onOpenDetail('user', user.id, user.displayName)}
                    className="text-blue-700 hover:text-blue-900 hover:underline truncate"
                  >
                    {user.displayName}
                  </button>
                  <span className="ml-auto font-mono text-gray-400 shrink-0">{user.riskScore}</span>
                  <TierBadge tier={user.riskTier} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function DepartmentDetailPage({ departmentName, cachedData, onCacheData, onClose, onOpenDetail }) {
  const { authFetch } = useAuth();
  const [tab, setTab] = useState('direct');
  const [node, setNode] = useState(cachedData?.node || null);
  const [loading, setLoading] = useState(!cachedData?.node);
  const [error, setError] = useState(null);

  // Fetch org chart data and rebuild tree if no cached data
  useEffect(() => {
    if (node) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch('/api/org-chart');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (cancelled) return;
        if (!json.available || !json.users) {
          setError('Org chart data not available.');
          setLoading(false);
          return;
        }
        const found = buildDeptTree(json.users, departmentName);
        if (!found) {
          setError(`Department "${departmentName}" not found in org chart.`);
        } else {
          setNode(found);
          if (onCacheData) onCacheData(departmentName, 'department', { node: found });
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [departmentName, authFetch, node, onCacheData]);

  const directMembers = node?.members || [];
  const allMembers = useMemo(() => node ? collectAllMembers(node) : [], [node]);
  const indirectMembers = useMemo(
    () => allMembers.filter(m => !directMembers.some(dm => dm.id === m.id)),
    [allMembers, directMembers]
  );
  const directRisk = useMemo(() => computeRisk(directMembers), [directMembers]);
  const allRisk = useMemo(() => computeRisk(allMembers), [allMembers]);
  const indirectRisk = useMemo(() => computeRisk(indirectMembers), [indirectMembers]);
  const subDepts = useMemo(() => node ? collectSubDepts(node) : [], [node]);

  const displayMembers = tab === 'direct' ? directMembers : tab === 'indirect' ? indirectMembers : allMembers;
  const displayRisk = tab === 'direct' ? directRisk : tab === 'indirect' ? indirectRisk : allRisk;

  // Sort members by risk score descending, then name
  const sortedMembers = useMemo(() => {
    return [...displayMembers].sort((a, b) => {
      const riskDiff = (b.riskScore || 0) - (a.riskScore || 0);
      if (riskDiff !== 0) return riskDiff;
      return (a.displayName || '').localeCompare(b.displayName || '');
    });
  }, [displayMembers]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading department details...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6 max-w-md mx-auto mt-12">
        <h2 className="text-red-800 font-semibold text-lg">Failed to load department</h2>
        <p className="text-red-600 mt-2 text-sm">{error}</p>
        <button onClick={onClose} className="mt-3 text-sm text-red-700 underline hover:text-red-900">Close</button>
      </div>
    );
  }

  if (!node) return null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 bg-gray-50">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-green-100 text-green-700 flex items-center justify-center text-lg font-bold">D</div>
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">{node.department}</h2>
                  <div className="text-sm text-gray-500 mt-0.5">
                    {node.directCount || directMembers.length} direct member{(node.directCount || directMembers.length) !== 1 ? 's' : ''}
                    {(node.indirectCount || 0) > 0 && (
                      <span> | {node.indirectCount} indirect</span>
                    )}
                    {node.children.length > 0 && (
                      <span> | {node.children.length} sub-department{node.children.length !== 1 ? 's' : ''}</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <TierBadge tier={directRisk.maxTier} showAll />
              <button
                onClick={onClose}
                className="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100"
                title="Close"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Risk distribution overview */}
        {TIER_DISPLAY.some(t => allRisk.tierCounts[t] > 0) && (
          <div className="flex gap-2 px-6 py-3 border-b border-gray-100">
            <span className="text-xs text-gray-500 mr-1 self-center">Overall risk:</span>
            {TIER_DISPLAY.filter(t => allRisk.tierCounts[t] > 0).map(t => {
              const s = TIER_STYLES[t];
              return (
                <span key={t} className={`${s.bg} ${s.text} text-xs px-2.5 py-0.5 rounded-full border ${s.border}`}>
                  {allRisk.tierCounts[t]} {t}
                </span>
              );
            })}
          </div>
        )}

        {/* Sub-departments summary */}
        {subDepts.length > 0 && (
          <div className="px-6 py-3 border-b border-gray-100">
            <div className="text-xs font-medium text-gray-500 mb-2">Sub-departments</div>
            <div className="flex flex-wrap gap-1.5">
              {subDepts.map((d, i) => (
                <span key={i} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                  {d.depth > 0 && <span className="text-gray-300">{'  '.repeat(d.depth)}</span>}
                  {d.name} <span className="text-gray-400">({d.directCount})</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Risk summary */}
      {allMembers.some(m => m.riskScore != null) && (
        <RiskSummary
          directMembers={directMembers}
          allMembers={allMembers}
          directRisk={directRisk}
          allRisk={allRisk}
          subDepts={subDepts}
          node={node}
          onOpenDetail={onOpenDetail}
        />
      )}

      {/* Members section */}
      <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
        {/* Tabs */}
        <div className="flex border-b border-gray-200 px-6 bg-gray-50">
          {[
            { key: 'direct', label: 'Direct Members', count: directMembers.length },
            ...(indirectMembers.length > 0
              ? [{ key: 'indirect', label: 'Indirect Members', count: indirectMembers.length }]
              : []),
            ...(indirectMembers.length > 0
              ? [{ key: 'all', label: 'All Members', count: allMembers.length }]
              : []),
          ].map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                tab === t.key
                  ? 'border-blue-500 text-blue-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label} ({t.count})
            </button>
          ))}
        </div>

        {/* Tab risk distribution */}
        {TIER_DISPLAY.some(t => displayRisk.tierCounts[t] > 0) && (
          <div className="flex gap-2 px-6 py-2 border-b border-gray-100">
            <span className="text-xs text-gray-400 mr-1 self-center">Avg. score: {displayRisk.avgScore}</span>
            <span className="text-gray-200 self-center">|</span>
            {TIER_DISPLAY.filter(t => displayRisk.tierCounts[t] > 0).map(t => {
              const s = TIER_STYLES[t];
              return (
                <span key={t} className={`${s.bg} ${s.text} text-[11px] px-2 py-0.5 rounded-full border ${s.border}`}>
                  {displayRisk.tierCounts[t]} {t}
                </span>
              );
            })}
          </div>
        )}

        {/* Members list */}
        <div className="divide-y divide-gray-50">
          {sortedMembers.map(user => (
            <div key={`${user.id}-${user._dept || ''}`} className="flex items-center gap-3 px-6 py-2.5 hover:bg-gray-50">
              <Avatar name={user.displayName} tier={user.riskTier} />
              <div className="min-w-0 flex-1">
                <button
                  onClick={() => onOpenDetail('user', user.id, user.displayName)}
                  className="text-sm text-blue-700 hover:text-blue-900 hover:underline truncate text-left block font-medium"
                >
                  {user.displayName}
                </button>
                <div className="text-xs text-gray-400 truncate">
                  {user.jobTitle || '\u2014'}
                  {tab !== 'direct' && user._dept && (
                    <span className="ml-1.5 text-gray-300">({user._dept})</span>
                  )}
                </div>
              </div>
              <TierBadge tier={user.riskTier} />
              {user.riskScore != null && (
                <span className="text-xs font-mono text-gray-400 w-8 text-right shrink-0">{user.riskScore}</span>
              )}
            </div>
          ))}
          {sortedMembers.length === 0 && (
            <div className="px-6 py-8 text-center text-sm text-gray-400">No members found.</div>
          )}
        </div>
      </div>
    </div>
  );
}
