// Label-computation helpers for the context tree, extracted from
// ContextTreeView.jsx so that file only exports its component (Vite
// fast-refresh requirement). Sibling nodes built by the manager-hierarchy
// plugin share a long path prefix ("CEO · ADIR · ADIR (…)" / "CEO · ADIR ·
// COO (…)"); these collapse repeated segments and strip the common prefix so
// each pill shows only its distinctive tail.

const PATH_SEP = ' · ';

// A segment's base name, ignoring a trailing "(Manager, Name)" suffix and case,
// so "Commercie" and "Commercie (Doorn, Matthijs)" compare equal.
function segBase(s) {
  return String(s).replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
}

// Collapse consecutive duplicate segments within a single name, keeping the last
// of each run (so a trailing manager suffix is preserved): "CEO · ADIR · ADIR
// (Siemons)" → "CEO · ADIR (Siemons)".
export function dedupeSegments(name) {
  const segs = String(name || '').split(PATH_SEP);
  const out = [];
  for (const seg of segs) {
    if (out.length && segBase(out[out.length - 1]) === segBase(seg)) out[out.length - 1] = seg;
    else out.push(seg);
  }
  return out.join(PATH_SEP);
}

// Split a name into its org path (segments, no manager) + the manager name from
// the trailing "(Manager, Name)". "CEO · ADIR (Siemons, Boudewijn)" →
// { org: ['CEO','ADIR'], manager: 'Siemons, Boudewijn' }.
export function parseOrg(displayName) {
  const segs = dedupeSegments(displayName).split(PATH_SEP);
  const last = segs[segs.length - 1] || '';
  const m = last.match(/\(([^)]*)\)\s*$/);
  const manager = m ? m[1].trim() : '';
  const orgLast = last.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const org = segs.slice(0, -1).concat(orgLast ? [orgLast] : []);
  return { org, manager, full: segs.join(PATH_SEP) };
}

// Drop the leading org segments a child shares with its parent (by base). May
// return an empty array when the child's org is identical to the parent's.
function stripLeadingOrg(childOrg, parentOrg) {
  let i = 0;
  while (i < parentOrg.length && i < childOrg.length && segBase(childOrg[i]) === segBase(parentOrg[i])) i++;
  return childOrg.slice(i);
}

// Compute each child's display label: collapse repeated segments, drop the
// parent's org path (so the parent's name isn't echoed down the tree), then drop
// any remaining org prefix common to all siblings. When a node's org is fully
// shared with its parent/siblings — only the manager differs — show just the
// manager's name. `parentOrg` is the parent's org segments ([] at the top).
export function computeChildLabels(siblings, parentOrg = []) {
  const map = new Map();
  const list = siblings || [];
  const items = list.map(s => {
    const { org, manager, full } = parseOrg(s.displayName);
    return { id: s.id, org: stripLeadingOrg(org, parentOrg), manager, lastOrg: org[org.length - 1] || '', full };
  });
  // Drop the org prefix common to all siblings (may collapse to manager-only).
  if (items.length >= 2) {
    const minLen = Math.min(...items.map(it => it.org.length));
    let common = 0;
    while (common < minLen) {
      const seg = items[0].org[common];
      if (seg && items.every(it => segBase(it.org[common]) === segBase(seg))) common++; else break;
    }
    if (common > 0) for (const it of items) it.org = it.org.slice(common);
  }
  for (const it of items) {
    let label;
    if (it.org.length > 0) label = it.org.join(PATH_SEP) + (it.manager ? ` (${it.manager})` : '');
    else if (it.manager) label = it.manager;          // org fully shared → just the delegate
    else label = it.lastOrg || it.full;               // no manager to fall back on
    map.set(it.id, label);
  }
  return map;
}

// Back-compat: sibling-prefix stripping is the top-level case (no parent).
export function stripSiblingPrefix(siblings) {
  return computeChildLabels(siblings, []);
}
