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

// Build one label-item per sibling: org path with the parent's prefix stripped,
// plus the pieces needed to fall back when the org collapses to nothing.
function buildLabelItems(list, parentOrg) {
  return list.map(s => {
    const { org, manager, full } = parseOrg(s.displayName);
    return { id: s.id, org: stripLeadingOrg(org, parentOrg), manager, lastOrg: org[org.length - 1] || '', full };
  });
}

// Length of the org prefix shared (by base) across every sibling.
function commonSiblingPrefixLen(items) {
  const minLen = Math.min(...items.map(it => it.org.length));
  let common = 0;
  while (common < minLen) {
    const seg = items[0].org[common];
    if (!seg || !items.every(it => segBase(it.org[common]) === segBase(seg))) break;
    common++;
  }
  return common;
}

// Drop the org prefix common to all siblings in place (may collapse to
// manager-only). Nothing to strip with fewer than two siblings.
function dropCommonSiblingPrefix(items) {
  if (items.length < 2) return;
  const common = commonSiblingPrefixLen(items);
  if (common > 0) for (const it of items) it.org = it.org.slice(common);
}

// One child's display label from its (already-stripped) label-item.
function labelForItem(it) {
  if (it.org.length > 0) return it.org.join(PATH_SEP) + (it.manager ? ` (${it.manager})` : '');
  if (it.manager) return it.manager;   // org fully shared → just the delegate
  return it.lastOrg || it.full;        // no manager to fall back on
}

// Compute each child's display label: collapse repeated segments, drop the
// parent's org path (so the parent's name isn't echoed down the tree), then drop
// any remaining org prefix common to all siblings. When a node's org is fully
// shared with its parent/siblings — only the manager differs — show just the
// manager's name. `parentOrg` is the parent's org segments ([] at the top).
export function computeChildLabels(siblings, parentOrg = []) {
  const items = buildLabelItems(siblings || [], parentOrg);
  dropCommonSiblingPrefix(items);
  const map = new Map();
  for (const it of items) map.set(it.id, labelForItem(it));
  return map;
}

// Back-compat: sibling-prefix stripping is the top-level case (no parent).
export function stripSiblingPrefix(siblings) {
  return computeChildLabels(siblings, []);
}
