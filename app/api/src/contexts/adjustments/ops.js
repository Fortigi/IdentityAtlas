// The six adjustment operations: request validation and the sentence the log
// shows. Pure — no database. What each op DOES to the tree is in apply.js.

import { isSelfOrAncestor } from './treeStore.js';

export const ADJUSTMENT_OPS = Object.freeze(['moveUnit', 'renameUnit', 'moveMember', 'addUnit', 'splitUnit', 'setManager']);
export const ADJUSTMENT_STATUSES = Object.freeze(['active', 'needsDecision', 'orphaned', 'matches', 'expired', 'reverted']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NAME = 500;
const MAX_PICKED = 5000;

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const lower = (v) => (isUuid(v) ? v.toLowerCase() : v);
const cleanName = (v) => (typeof v === 'string' ? v.trim().slice(0, MAX_NAME) : '');

class Invalid extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export { Invalid as AdjustmentInvalid };

function unitInTree(tree, id, what) {
  if (!isUuid(id)) throw new Invalid(`${what} (uuid) is required`);
  const unit = tree.byId.get(id.toLowerCase());
  if (!unit) throw new Invalid(`${what} is not a unit of this tree`, 404);
  return unit;
}

function optionalParent(tree, id) {
  if (id === null || id === undefined || id === '') return null;
  return unitInTree(tree, id, 'The parent').id;
}

const VALIDATORS = {
  moveUnit(body, tree) {
    const subject = unitInTree(tree, body.subjectId, 'subjectId');
    const toParentId = optionalParent(tree, body.toParentId);
    if (toParentId && isSelfOrAncestor(tree, subject.id, toParentId)) throw new Invalid('A unit cannot move into itself or one of its own sub-units');
    if ((subject.parentId || null) === toParentId) throw new Invalid('The unit is already there');
    return { subjectId: subject.id, payload: { toParentId } };
  },
  renameUnit(body, tree) {
    const subject = unitInTree(tree, body.subjectId, 'subjectId');
    const name = cleanName(body.name);
    if (!name) throw new Invalid('name is required');
    if (name === subject.name) throw new Invalid('The unit already has that name');
    return { subjectId: subject.id, payload: { name } };
  },
  moveMember(body, tree) {
    if (!isUuid(body.memberId)) throw new Invalid('memberId (uuid) is required');
    const from = unitInTree(tree, body.fromUnitId, 'fromUnitId');
    const to = unitInTree(tree, body.toUnitId, 'toUnitId');
    if (from.id === to.id) throw new Invalid('The member is already in that unit');
    return { subjectId: to.id, memberId: lower(body.memberId), payload: { fromUnitId: from.id, toUnitId: to.id } };
  },
  addUnit(body, tree) {
    const name = cleanName(body.name);
    if (!name) throw new Invalid('name is required');
    const parentId = optionalParent(tree, body.parentId);
    return { subjectId: parentId, payload: { name, parentId } };
  },
  splitUnit(body, tree) {
    const subject = unitInTree(tree, body.subjectId, 'subjectId');
    if (Array.isArray(body.memberIds)) return splitByMembers(body, subject);
    return splitByAttribute(body, subject, tree);
  },
  setManager(body, tree) {
    const subject = unitInTree(tree, body.subjectId, 'subjectId');
    if (!isUuid(body.principalId)) throw new Invalid('principalId (uuid) is required');
    const interim = body.interim === true;
    const validUntil = body.validUntil ? String(body.validUntil) : null;
    if (validUntil && !DATE_RE.test(validUntil)) throw new Invalid('validUntil must be a date (YYYY-MM-DD)');
    return { subjectId: subject.id, payload: { principalId: lower(body.principalId), interim }, validUntil };
  },
};

function splitByMembers(body, subject) {
  const memberIds = [...new Set(body.memberIds.filter(isUuid).map(lower))];
  if (memberIds.length === 0) throw new Invalid('Pick at least one member to split off');
  if (memberIds.length > MAX_PICKED) throw new Invalid(`At most ${MAX_PICKED} members can be picked at once`);
  const name = cleanName(body.name);
  if (!name) throw new Invalid('name is required when splitting picked members');
  return { subjectId: subject.id, payload: { memberIds, name } };
}

function splitByAttribute(body, subject, tree) {
  if (tree.targetType !== 'Principal') throw new Invalid('Splitting by an attribute works on trees of accounts; pick members instead');
  const attribute = typeof body.attribute === 'string' ? body.attribute.trim() : '';
  const value = typeof body.value === 'string' ? body.value.trim() : '';
  if (!attribute || !value) throw new Invalid('attribute and value are required (or memberIds)');
  return { subjectId: subject.id, payload: { attribute, value, name: cleanName(body.name) || value } };
}

// Validate a POST body against the loaded tree. Returns the row fields
// { op, subjectId, memberId, payload, validUntil, reason }; throws AdjustmentInvalid.
export function validateAdjustment(body, tree) {
  const op = body?.op;
  if (!ADJUSTMENT_OPS.includes(op)) throw new Invalid(`op must be one of ${ADJUSTMENT_OPS.join(', ')}`);
  const fields = VALIDATORS[op](body, tree);
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 2000) : null;
  return { op, subjectId: null, memberId: null, validUntil: null, ...fields, reason };
}

// A DATE as 'YYYY-MM-DD'. node-postgres hands a DATE back as a Date at local
// midnight, so it is read in local time; a string is taken as it is.
export function dateText(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}

function describeSplit(p, subject) {
  return p.attribute
    ? `Split ${p.attribute} "${p.value}" off ${subject}`
    : `Split ${p.memberIds?.length ?? 0} member(s) off ${subject} into "${p.name}"`;
}

function describeSetManager(adj, p, subject, managerName) {
  const until = adj.validUntil ? ` until ${dateText(adj.validUntil)}` : '';
  return `${managerName || 'Someone'} ${p.interim ? 'is interim manager of' : 'manages'} ${subject}${until}`;
}

// The sentence the log shows. `nameOf(id)` returns a unit's current name (or
// null when it is gone); `memberName` and `managerName` are looked up by the caller.
export function describeAdjustment(adj, { nameOf, memberName, managerName } = {}) {
  const unit = (id, fallback) => (id && nameOf?.(id)) || fallback || 'a unit that is gone';
  const subject = unit(adj.subjectId, adj.snapshot?.name);
  const p = adj.payload || {};
  switch (adj.op) {
    case 'moveUnit': return `Move ${subject} ${p.toParentId ? `under ${unit(p.toParentId)}` : 'to the top level'}`;
    case 'renameUnit': return `Rename ${adj.snapshot?.name || subject} to "${p.name}"`;
    case 'moveMember': return `Move ${memberName || 'a member'} from ${unit(p.fromUnitId)} to ${unit(p.toUnitId)}`;
    case 'addUnit': return `Add unit "${p.name}" ${p.parentId ? `under ${unit(p.parentId)}` : 'at the top level'}`;
    case 'splitUnit': return describeSplit(p, subject);
    case 'setManager': return describeSetManager(adj, p, subject, managerName);
    default: return adj.op;
  }
}
