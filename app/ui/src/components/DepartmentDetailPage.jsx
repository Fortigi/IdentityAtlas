import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { TIER_ORDER } from './departmentTiers';
import DepartmentHeader from './DepartmentHeader';
import RiskSummary from './RiskSummary';
import MembersSection from './MembersSection';

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

  function countSubtree(node) {
    let indirect = 0;
    for (const child of node.children) indirect += countSubtree(child);
    node.directCount = node.members.length;
    node.indirectCount = indirect;
    node.subtreeCount = node.members.length + indirect;
    return node.subtreeCount;
  }

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

export default function DepartmentDetailPage({ departmentName, cachedData, onCacheData, onClose, onOpenDetail }) {
  const { authFetch } = useAuth();
  const [node, setNode] = useState(cachedData?.node || null);
  const [loading, setLoading] = useState(!cachedData?.node);
  const [error, setError] = useState(null);

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

  const directMembers = useMemo(() => node?.members || [], [node]);
  const allMembers = useMemo(() => node ? collectAllMembers(node) : [], [node]);
  const indirectMembers = useMemo(
    () => allMembers.filter(m => !directMembers.some(dm => dm.id === m.id)),
    [allMembers, directMembers]
  );
  const directRisk = useMemo(() => computeRisk(directMembers), [directMembers]);
  const allRisk = useMemo(() => computeRisk(allMembers), [allMembers]);
  const indirectRisk = useMemo(() => computeRisk(indirectMembers), [indirectMembers]);
  const subDepts = useMemo(() => node ? collectSubDepts(node) : [], [node]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500 dark:text-gray-400">Loading department details...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg p-6 max-w-md mx-auto mt-12">
        <h2 className="text-red-800 dark:text-red-300 font-semibold text-lg">Failed to load department</h2>
        <p className="text-red-600 dark:text-red-400 mt-2 text-sm">{error}</p>
        <button onClick={onClose} className="mt-3 text-sm text-red-700 dark:text-red-400 underline hover:text-red-900 dark:hover:text-red-300">Close</button>
      </div>
    );
  }

  if (!node) return null;

  return (
    <div className="space-y-4">
      <DepartmentHeader
        node={node}
        directMembers={directMembers}
        directRisk={directRisk}
        allRisk={allRisk}
        subDepts={subDepts}
        onClose={onClose}
      />

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

      <MembersSection
        directMembers={directMembers}
        indirectMembers={indirectMembers}
        allMembers={allMembers}
        directRisk={directRisk}
        indirectRisk={indirectRisk}
        allRisk={allRisk}
        onOpenDetail={onOpenDetail}
      />
    </div>
  );
}
