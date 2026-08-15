// Pure helpers for the manager-hierarchy context plugin.
//
// Extracted so the plugin's run() stays a thin orchestrator: each phase (regex
// compilation, name-field resolution, SELECT building, node naming, and the
// manager/member fold) lives here as an independently testable unit. None of
// these touch the database — run() still owns every query.

import RE2 from 're2';

// Compile exclude patterns up front so we fail the run — not every row — on a
// malformed regex. RE2 guarantees linear-time matching, so an admin-supplied
// pattern can't cause catastrophic backtracking.
export function compileExcludeRegexes(patterns) {
  return (patterns || []).map((src, i) => {
    try { return new RE2(src, 'i'); }
    catch (e) { throw new Error(`excludeNamePatterns[${i}] is not a valid regex: ${e.message}`); }
  });
}

// True when a display name matches any compiled exclude pattern.
export function matchesExclude(name, regexes) {
  return !!name && regexes.some(re => re.test(name));
}

// Resolve each requested name field to a REAL Principal column or an
// extendedAttributes key — both validated against whitelists so a field name
// never reaches SQL unchecked. Unknown fields drop; fall back to department.
// Returns [{ name, real }].
export function resolveNameFields(nameFields, validCols, validExtKeys) {
  const requested = (Array.isArray(nameFields) ? nameFields : []).filter(f => typeof f === 'string');
  const resolved = [];
  for (const f of requested) {
    if (validCols.has(f)) resolved.push({ name: f, real: true });
    else if (validExtKeys.has(f)) resolved.push({ name: f, real: false });
  }
  if (resolved.length === 0 && validCols.has('department')) resolved.push({ name: 'department', real: true });
  return resolved;
}

// Build the SELECT column list + params. Real columns inline (whitelisted);
// extended keys via a parameterized ->> aliased to the key name so each value
// is read by name. Returns { selectParts, queryParams }.
export function buildSelectParts(resolved, scopeSystemId) {
  const selectParts = ['id', '"displayName"', '"managerId"'];
  const queryParams = [scopeSystemId];
  for (const r of resolved) {
    if (r.real) {
      selectParts.push(`"${r.name}"`);
    } else {
      queryParams.push(r.name);
      selectParts.push(`"extendedAttributes" ->> $${queryParams.length} AS "${r.name}"`);
    }
  }
  return { selectParts, queryParams };
}

// Build a node name from the resolved fields (+ optional manager name).
// `naming` is { resolved, separator, includeManagerName }.
export function buildNodeName(mgr, naming) {
  const { resolved, separator, includeManagerName } = naming;
  const mgrName = mgr?.displayName || 'Unknown';
  const parts = resolved
    .map(r => (mgr?.[r.name] == null ? '' : String(mgr[r.name]).trim()))
    .filter(Boolean)
    // Collapse consecutive duplicate segments — org levels frequently repeat
    // the same name (e.g. "Commercie · Commercie"); keep just one.
    .filter((p, i, arr) => i === 0 || p.toLowerCase() !== arr[i - 1].toLowerCase());
  const label = parts.join(separator);
  if (label && includeManagerName) return `${label} (${mgrName})`;
  if (label) return label;
  return mgrName; // no attribute values → fall back to the person's name
}

// The effective managerId for a principal: an analyst override takes precedence
// over the source managerId (null override = report to root).
export function effectiveManagerId(principal, overrides) {
  return overrides.has(principal.id) ? overrides.get(principal.id) : principal.managerId;
}

// Compute the set of manager node ids. Start from every referenced managerId,
// drop anyone whose displayName matches an exclude pattern (their would-be
// reports fall through to root later), then add every override target that
// exists so a moved member always has a team to land in.
// Returns { managerIds, excludedCount }.
export function buildManagerIds(rows, byId, excludeRegexes, overrides) {
  const managerIds = new Set();
  let excludedCount = 0;
  for (const r of rows) {
    if (!r.managerId) continue;
    const mgr = byId.get(r.managerId);
    if (mgr && matchesExclude(mgr.displayName, excludeRegexes)) { excludedCount++; continue; }
    managerIds.add(r.managerId);
  }
  for (const target of overrides.values()) {
    if (target && byId.has(target)) managerIds.add(target);
  }
  return { managerIds, excludedCount };
}

// One context per manager. parentExternalId = the manager's own managerId (if
// that person is also a manager node); otherwise root.
export function buildManagerContexts(managerIds, byId, rootExt, naming) {
  const contexts = [];
  for (const managerId of managerIds) {
    const mgr = byId.get(managerId);
    const parentManagerId = mgr?.managerId && managerIds.has(mgr.managerId) ? mgr.managerId : null;
    contexts.push({
      externalId: managerId,
      displayName: buildNodeName(mgr, naming),
      contextType: 'ManagerHierarchy',
      parentExternalId: parentManagerId || rootExt,
    });
  }
  return contexts;
}

// Every principal with an effective manager becomes a member of that manager's
// context. If the manager was excluded or isn't in the dataset, the principal
// goes to root instead — unless it is itself a top-level manager node.
export function buildMemberRows(rows, managerIds, overrides, rootExt) {
  const members = [];
  for (const p of rows) {
    const em = effectiveManagerId(p, overrides);
    if (em && managerIds.has(em)) {
      members.push({ contextExternalId: em, memberId: p.id });
    } else if (!managerIds.has(p.id)) {
      members.push({ contextExternalId: rootExt, memberId: p.id });
    }
    // else: p is a top-level manager (no manager, but has reports).
  }
  return members;
}
