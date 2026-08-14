// Pure helpers extracted from engine.js to keep the scoring passes small and
// individually testable. Two groups:
//   1. Index builders — turn flat DB rows into the lookup maps loadScoringData
//      hands to the scoring passes.
//   2. Membership-analysis scoring signals — each applies one v4 signal to a
//      principal's mutable `state` (score + reason strings). Logic is moved
//      verbatim from analyzeMembershipForPrincipal.
// No DB, no imports — safe to unit-test directly.

// ─── Index builders ───────────────────────────────────────────────────

// Manager → direct reports index. Only used when the Entra crawler has
// populated managerId — if the column is empty across the board, hierarchy
// signals gracefully degrade to 0 (hierarchyAvailable === false).
export function indexDirectReports(principalRows) {
  const directReports = new Map(); // managerId -> Set<reportPid>
  for (const p of principalRows) {
    if (!p.managerId) continue;
    const mid = String(p.managerId);
    if (!directReports.has(mid)) directReports.set(mid, new Set());
    directReports.get(mid).add(String(p.id));
  }
  return { directReports, hierarchyAvailable: directReports.size > 0 };
}

// Bidirectional membership index: principal → list of resource ids (memberships)
// and resource → list of principal ids (members).
export function indexMemberships(assignmentRows) {
  const principalMemberships = new Map(); // pid -> Set<rid>
  const resourceMembers      = new Map(); // rid -> Set<pid>
  for (const a of assignmentRows) {
    if (!principalMemberships.has(a.pid)) principalMemberships.set(a.pid, new Set());
    principalMemberships.get(a.pid).add(a.rid);
    if (!resourceMembers.has(a.rid)) resourceMembers.set(a.rid, new Set());
    resourceMembers.get(a.rid).add(a.pid);
  }
  return { principalMemberships, resourceMembers };
}

// Ownerships: principal → set of owned group ids.
export function indexOwnerships(ownerRows) {
  const principalOwnerships = new Map();
  for (const a of ownerRows) {
    if (!principalOwnerships.has(a.pid)) principalOwnerships.set(a.pid, new Set());
    principalOwnerships.get(a.pid).add(a.rid);
  }
  return principalOwnerships;
}

// BFS the directReports graph from one root's reports and return the number of
// distinct principals reachable (the org subtree size). Iterative to avoid
// PowerShell v4's recursion.
export function countSubtree(rootReports, directReports) {
  const seen = new Set();
  const queue = [...rootReports];
  while (queue.length > 0) {
    const next = queue.shift();
    if (seen.has(next)) continue;
    seen.add(next);
    const reports = directReports.get(next);
    if (reports) for (const r of reports) queue.push(r);
  }
  return seen.size;
}

// ─── Membership-analysis scoring signals (mutate `state`) ─────────────

// Broad access footprint: in >15 groups → +3 per 3 above, capped at 15.
export function scoreBroadAccess(state, totalGroups) {
  if (totalGroups <= 15) return;
  const points = Math.min(15, Math.floor((totalGroups - 15) / 3) * 3);
  if (points <= 0) return;
  state.membershipScore += points;
  state.membershipReasons.push(`Member of ${totalGroups} groups (above threshold of 15) — broad access footprint [+${points}]`);
}

// Riskiest group (direct score ≥ 70) the principal is a member of, or null.
export function findHighRiskMembership(memSet, resourceState) {
  let highRiskMembership = null;
  let highRiskGroupScore = 0;
  for (const rid of memSet) {
    const rs = resourceState.get(rid);
    if (rs && rs.directScore >= 70 && rs.directScore > highRiskGroupScore) {
      highRiskGroupScore = rs.directScore;
      highRiskMembership = rs;
    }
  }
  return highRiskMembership;
}

// Member of any high-risk group: +15, once only.
export function scoreHighRiskMembership(state, memSet, resourceState) {
  const highRiskMembership = findHighRiskMembership(memSet, resourceState);
  if (!highRiskMembership) return;
  state.membershipScore += 15;
  state.membershipReasons.push(
    `Member of high-risk group '${highRiskMembership.row.displayName}' ` +
    `(direct score ${highRiskMembership.directScore}) — elevated privilege exposure [+15]`
  );
}

// Large org subtree: v4 ≥100→+15, ≥50→+12, ≥25→+10, ≥10→+5.
export function scoreOrgSubtree(state, subtree) {
  if (subtree < 10) return;
  const subtreePoints = subtree >= 100 ? 15 : subtree >= 50 ? 12 : subtree >= 25 ? 10 : 5;
  state.membershipScore += subtreePoints;
  state.membershipReasons.push(`${subtree} total reports in org subtree — large blast radius [+${subtreePoints}]`);
}

// Manager of high-risk direct reports: +5 per high-risk report, cap 15.
export function scoreHighRiskReports(state, reports, principalState) {
  let highRiskReports = 0;
  for (const reportPid of reports) {
    const rs = principalState.get(reportPid);
    if (rs && rs.directScore >= 70) highRiskReports++;
  }
  if (highRiskReports <= 0) return;
  const mgrPoints = Math.min(15, highRiskReports * 5);
  state.membershipScore += mgrPoints;
  state.membershipReasons.push(`Manager of ${highRiskReports} high-risk direct report(s) — inherited responsibility [+${mgrPoints}]`);
}

// Hierarchy signals (only meaningful when managerId is populated in the tenant).
export function scoreHierarchySignals(state, pid, ctx) {
  const { directReports, principalState, subtreeCount } = ctx;
  scoreOrgSubtree(state, subtreeCount.get(pid) || 0);
  scoreHighRiskReports(state, directReports.get(pid) || new Set(), principalState);
}
