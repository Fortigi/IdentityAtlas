// The manager-hierarchy plugin's optional layout parameters: their schema,
// validation, the extra columns they need, and applying them in order.
// The steps themselves are in manager-hierarchy.layout.js.

import RE2 from 're2';
import { buildNodeName } from './manager-hierarchy.helpers.js';
import { splitUnits, nameUnitsFromMembers, findTops, placeUnderTops } from './manager-hierarchy.layout.js';

export const LAYOUT_PARAMETERS = Object.freeze({
  topMode: {
    type: 'string', enum: ['auto', 'jobTitle', 'people'], default: 'auto',
    'x-enumLabels': { auto: 'Everyone without a manager', jobTitle: 'By job title', people: 'Chosen people' },
    description: 'Where the organisation starts. auto: everyone without a manager. jobTitle: the people whose job title matches topJobTitle. people: the people in topPrincipalIds.',
  },
  topJobTitle: { type: 'string', description: 'With topMode jobTitle: a pattern for the top job title, e.g. "^CEO$" (case-insensitive).' },
  topPrincipalIds: { type: 'array', items: { type: 'string', format: 'uuid' }, description: 'With topMode people: the account ids at the top.' },
  notPlacedUnit: {
    type: 'boolean', default: false,
    description: 'Collect people and teams that are not under the top in a separate "Not placed" unit (always on when the top is chosen).',
  },
  nameFrom: {
    type: 'string', enum: ['manager', 'members'], default: 'manager',
    'x-enumLabels': { manager: 'The manager', members: 'What its people share' },
    description: 'Name a unit after the manager\'s own attributes, or after what most of its members share (a CFO sits in the board\'s department but runs Finance).',
  },
  splitBy: {
    type: 'string', 'x-attributeSource': 'principal',
    description: 'Split a manager\'s people into one unit per value of this attribute (e.g. department) — for managers who run several teams, or an interim one.',
  },
  splitMinMembers: { type: 'integer', default: 2, minimum: 1, description: 'With splitBy: the smallest group that gets a unit of its own.' },
  excludeInactive: { type: 'boolean', default: false, description: 'Leave out disabled accounts (leavers).' },
});

function resolveField(name, validCols, validExtKeys) {
  if (typeof name !== 'string' || !name.trim()) return null;
  const f = name.trim();
  if (validCols.has(f)) return { name: f, real: true };
  if (validExtKeys.has(f)) return { name: f, real: false };
  return null;
}

function compileTopTitle(pattern) {
  try { return new RE2(pattern, 'i'); }
  catch (e) { throw new Error(`topJobTitle is not a valid pattern: ${e.message}`); }
}

// The validated layout options. Throws on a parameter that cannot work.
export function resolveLayout(params, validCols, validExtKeys) {
  const topMode = ['jobTitle', 'people'].includes(params.topMode) ? params.topMode : 'auto';
  if (topMode === 'jobTitle' && !params.topJobTitle) throw new Error('topJobTitle is required when topMode is jobTitle');
  if (topMode === 'people' && !(Array.isArray(params.topPrincipalIds) && params.topPrincipalIds.length)) {
    throw new Error('topPrincipalIds is required when topMode is people');
  }
  const min = parseInt(params.splitMinMembers, 10);
  return {
    topMode,
    topJobTitleRegex: topMode === 'jobTitle' ? compileTopTitle(String(params.topJobTitle)) : null,
    topPrincipalIds: topMode === 'people' ? params.topPrincipalIds : null,
    notPlacedUnit: topMode !== 'auto' || params.notPlacedUnit === true,
    nameFromMembers: params.nameFrom === 'members',
    split: resolveField(params.splitBy, validCols, validExtKeys),
    splitMinMembers: Number.isFinite(min) && min > 0 ? min : 2,
    excludeInactive: params.excludeInactive === true && validCols.has('accountEnabled'),
    jobTitleColumn: validCols.has('jobTitle'),
  };
}

// The name fields plus the columns the layout reads, each once.
export function withLayoutFields(resolved, layout, validCols) {
  const extra = [
    layout.split,
    layout.topMode === 'jobTitle' && layout.jobTitleColumn ? { name: 'jobTitle', real: true } : null,
    layout.excludeInactive && validCols.has('accountEnabled') ? { name: 'accountEnabled', real: true } : null,
  ].filter(Boolean);
  const seen = new Set(resolved.map(r => r.name));
  return [...resolved, ...extra.filter(f => !seen.has(f.name) && seen.add(f.name))];
}

// Drop disabled accounts; whoever reported to one now has no manager.
export function excludeInactive(rows, layout) {
  if (!layout.excludeInactive) return rows;
  const kept = rows.filter(r => r.accountEnabled !== false);
  const ids = new Set(kept.map(r => r.id));
  return kept.map(r => (r.managerId && !ids.has(r.managerId) ? { ...r, managerId: null } : r));
}

export function applyLayout(result, { rows, byId, managerIds, rootExt, naming, layout }) {
  if (layout.split) {
    splitUnits(result, byId, {
      field: layout.split.name, minMembers: layout.splitMinMembers, managerIds,
      naming: (value, mgr) => (naming.includeManagerName && mgr?.displayName ? `${value} (${mgr.displayName})` : value),
    });
  }
  if (layout.nameFromMembers) {
    nameUnitsFromMembers(result, byId, {
      fields: naming.resolved.map(r => r.name), rootExt,
      buildName: (row) => buildNodeName(row, naming),
    });
  }
  const tops = findTops(rows, { topPrincipalIds: layout.topPrincipalIds, topJobTitleRegex: layout.topJobTitleRegex });
  return placeUnderTops(result, { tops, rootExt, notPlacedUnit: layout.notPlacedUnit });
}
