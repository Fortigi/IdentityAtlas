// Set the owners of many business roles from an uploaded list (csv or xlsx).
//
// Columns: the business role (id, external id or exact name), Accountable and
// Responsible. A cell may name several people, separated by ; or |, because a
// display name can itself hold a comma ("Jansen, Piet"). People are matched as
// the context upload matches them (e-mail, employee id, external id, name).
//
// The preview and the apply run the same plan, so what you saw is what happens.
// An Accountable a person chose by hand is never replaced: it shows as kept.

import { matchAll } from '../contexts/upload/members.js';
import { ListParseError } from '../contexts/upload/parse.js';
import { setBusinessRoleOwner } from './businessRoleOwners.js';

const ROLE_HEADERS = new Set(['businessrole', 'role', 'accesspackage', 'name', 'id']);
const normalizeHeader = (h) => String(h).toLowerCase().replace(/[\s_-]/g, '');

export const splitHolders = (cell) => String(cell ?? '').split(/[;|]/).map(s => s.trim()).filter(Boolean);

export function readOwnerRows({ columns, rows }) {
  const find = (test) => columns.find(c => test(normalizeHeader(c)));
  const roleCol = find(h => ROLE_HEADERS.has(h));
  const accountableCol = find(h => h === 'accountable');
  const responsibleCol = find(h => h === 'responsible');
  if (!roleCol) throw new ListParseError('Add a "Business role" column with the id or exact name of each role.');
  if (!accountableCol && !responsibleCol) throw new ListParseError('Add an "Accountable" or a "Responsible" column.');
  return rows.map((row, i) => ({
    line: i + 2,
    businessRole: String(row[roleCol] ?? '').trim(),
    accountable: accountableCol ? splitHolders(row[accountableCol]) : [],
    responsible: responsibleCol ? splitHolders(row[responsibleCol]) : [],
  })).filter(r => r.businessRole || r.accountable.length || r.responsible.length);
}

// (value) → { id, displayName } | { ambiguous: true } | null. A key the role
// shares with another role is ambiguous, never a guess.
export function buildRoleMatcher(roles) {
  const index = new Map();
  const add = (key, role) => {
    if (!key) return;
    const k = String(key).toLowerCase();
    if (!index.has(k)) index.set(k, new Map());
    index.get(k).set(role.id, role);
  };
  for (const role of roles) {
    add(role.id, role);
    add(role.externalId, role);
    add(role.displayName, role);
  }
  return (value) => {
    const hits = index.get(String(value).toLowerCase());
    if (!hits) return null;
    return hits.size > 1 ? { ambiguous: true } : [...hits.values()][0];
  };
}

export function accountableAction(current, principalId) {
  if (!current) return 'set';
  if (current.principalId === principalId) return 'same';
  return current.addedBy === 'analyst' ? 'kept' : 'replace';
}

const change = (role, value, principalId, names, action) => ({
  role, value, principalId: principalId ?? null, displayName: names.get(principalId) ?? null, action,
});

function accountableChanges(entry, ctx, owners) {
  if (entry.accountable.length > 1) {
    return [{ role: 'Accountable', value: entry.accountable.join('; '), principalId: null, displayName: null, action: 'tooMany' }];
  }
  return entry.accountable.map((value) => {
    const id = ctx.people.get(value);
    if (!id) return change('Accountable', value, null, ctx.names, 'unmatched');
    return change('Accountable', value, id, ctx.names, accountableAction(owners.find(o => o.role === 'Accountable'), id));
  });
}

function responsibleChanges(entry, ctx, owners) {
  return entry.responsible.map((value) => {
    const id = ctx.people.get(value);
    if (!id) return change('Responsible', value, null, ctx.names, 'unmatched');
    const held = owners.some(o => o.role === 'Responsible' && o.principalId === id);
    return change('Responsible', value, id, ctx.names, held ? 'same' : 'add');
  });
}

export function planRow(entry, ctx) {
  const hit = ctx.matchRole(entry.businessRole);
  const base = { line: entry.line, businessRole: entry.businessRole };
  if (!hit) return { ...base, problem: 'Business role not found', changes: [] };
  if (hit.ambiguous) return { ...base, problem: 'More than one business role has this name', changes: [] };
  const owners = ctx.owners.get(hit.id) ?? [];
  return {
    ...base,
    businessRoleId: hit.id,
    businessRoleName: hit.displayName,
    changes: [...accountableChanges(entry, ctx, owners), ...responsibleChanges(entry, ctx, owners)],
  };
}

const WRITES = new Set(['set', 'replace', 'add']);

export function summarize(rows) {
  const s = { roles: 0, toWrite: 0, unchanged: 0, kept: 0, problems: 0 };
  for (const row of rows) {
    if (row.problem) { s.problems++; continue; }
    s.roles++;
    for (const { action } of row.changes) {
      if (WRITES.has(action)) s.toWrite++;
      else if (action === 'same') s.unchanged++;
      else if (action === 'kept') s.kept++;
      else s.problems++;
    }
  }
  return s;
}

async function loadContext(db, entries) {
  const roles = (await db.query(`
    SELECT id, "displayName", "externalId" FROM "Resources"
     WHERE "resourceType" = 'BusinessRole' AND "deletedAt" IS NULL`)).rows;
  const values = [...new Set(entries.flatMap(e => [...e.accountable, ...e.responsible]))];
  const { ids, stats } = await matchAll(db, { Principal: values });
  const people = ids.Principal ?? new Map();
  const nameRows = people.size === 0 ? [] : (await db.query(
    `SELECT id, "displayName" FROM "Principals" WHERE id = ANY($1::uuid[])`, [[...new Set(people.values())]],
  )).rows;
  const existing = (await db.query(`SELECT "resourceId", role, "principalId", "addedBy" FROM "BusinessRoleOwners"`)).rows;
  const owners = new Map();
  for (const o of existing) owners.set(o.resourceId, [...(owners.get(o.resourceId) ?? []), o]);
  return {
    matchRole: buildRoleMatcher(roles), people, owners,
    names: new Map(nameRows.map(r => [r.id, r.displayName])),
    nearMatches: stats.fuzzySamples,
  };
}

export async function planOwnerImport(db, table) {
  const entries = readOwnerRows(table);
  const ctx = await loadContext(db, entries);
  const rows = entries.map(e => planRow(e, ctx));
  return { rows, summary: summarize(rows), nearMatches: ctx.nearMatches };
}

export async function applyOwnerPlan(plan, set = setBusinessRoleOwner) {
  let written = 0;
  let kept = 0;
  for (const row of plan.rows) {
    for (const c of row.changes) {
      if (!WRITES.has(c.action)) continue;
      const saved = await set(row.businessRoleId, { role: c.role, holderCol: 'principalId', holderId: c.principalId }, 'import');
      if (saved) written++; else kept++;
    }
  }
  return { written, kept };
}
