// One emitter per CSV file. Each streams its rows from the plan through a
// CsvWriter and returns { file, rows, bytes }. Column order follows the canonical
// headers in tools/crawlers/csv/schema/; columns after those are extras the
// crawler keeps in extendedAttributes.

import path from 'node:path';
import { CsvWriter, formatField } from './csvWriter.mjs';
import { opaqueId, stream, fmix32 } from './random.mjs';
import { IDENTITY_STORE, coprimeStride } from './plan.mjs';
import {
  userName, userAttributes, applicationName, entitlementValue, entitlementDescription,
  nearCollision, collisionSource,
} from './names.mjs';

export const HEADERS = Object.freeze({
  systems: ['ExternalId', 'DisplayName', 'SystemType', 'Description'],
  contexts: ['ExternalId', 'DisplayName', 'ContextType', 'TargetType', 'Description', 'ParentExternalId', 'SystemName', 'OwnerUserId', 'CmdbReference'],
  resources: ['ExternalId', 'DisplayName', 'ResourceType', 'Description', 'SystemName', 'Enabled', 'EntitlementValue'],
  contextMembers: ['ContextExternalId', 'MemberExternalId', 'MemberType'],
  users: ['ExternalId', 'DisplayName', 'Email', 'PrincipalType', 'JobTitle', 'Department', 'ManagerExternalId', 'SystemName', 'Enabled', 'EmployeeType'],
  assignments: ['ResourceExternalId', 'UserExternalId', 'AssignmentType', 'SystemName'],
});

export const CONTEXT_TYPE = 'LogicalApplication';

// Ids — pure functions of (plan, index).
export const principalId = (plan, i) => opaqueId('P', i, plan.keys.principal);
export const entitlementId = (plan, e) => opaqueId('E', e, plan.keys.entitlement);
export const roleId = (plan, r) => opaqueId('R', r, plan.keys.role);
export const applicationId = (plan, a) => opaqueId('A', a, plan.keys.app);
const systemId = (plan, i) => opaqueId('S', i, plan.keys.system);

function open(dir, file, header, opts) {
  return new CsvWriter(path.join(dir, file), header, opts);
}

async function finish(w, file) {
  const { rows, bytes } = await w.close();
  return { file, rows, bytes };
}

export async function writeSystems(plan, dir, opts) {
  const w = open(dir, 'Systems.csv', HEADERS.systems, opts);
  await w.writeRow([systemId(plan, 0), IDENTITY_STORE.name, IDENTITY_STORE.type, 'Identity source, business roles and logical applications']);
  for (const c of plan.connectors) {
    await w.writeRow([systemId(plan, c.index + 1), c.name, c.type, `Technical connector, ${c.type}${c.directory ? ', directory-style values' : ''}`]);
  }
  return finish(w, 'Systems.csv');
}

// Owner of a logical application: an enabled principal, deterministically chosen.
function enabledPrincipalNear(plan, start) {
  const n = plan.enabled.length;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (plan.enabled[i]) return i;
  }
  return start % n;
}

export async function writeContexts(plan, dir, opts) {
  const w = open(dir, 'Contexts.csv', HEADERS.contexts, opts);
  const rng = stream(plan.params.seed, 'contexts');
  for (let a = 0; a < plan.params.logicalApplications; a++) {
    const owner = principalId(plan, enabledPrincipalNear(plan, rng.int(plan.params.principals)));
    const cmdb = `CI${String(1000000 + rng.int(8999999)).padStart(7, '0')}`;
    const name = applicationName(a, plan.keys.name);
    await w.writeRow([applicationId(plan, a), name, CONTEXT_TYPE, 'Resource',
      `Logical application ${name}, spans ${1 + plan.apps.secondaries[a].length} connector(s)`, '', IDENTITY_STORE.name, owner, cmdb]);
  }
  return finish(w, 'Contexts.csv');
}

// Display name of entitlement e: its raw value, or — for the configured share of
// rows — a near-collision of an earlier entitlement's value.
export function entitlementDisplayName(plan, e) {
  const src = collisionSource(e, plan.keys.name, plan.params.nameCollisionShare);
  const value = (i) => entitlementValue(i, plan.keys.entitlement, plan.connectors[plan.entConnector[i]]);
  return src < 0 ? value(e) : nearCollision(value(src), e);
}

export async function writeResources(plan, dir, opts) {
  const w = open(dir, 'Resources.csv', HEADERS.resources, opts);
  for (let e = 0; e < plan.params.entitlements; e++) {
    const c = plan.connectors[plan.entConnector[e]];
    const value = entitlementValue(e, plan.keys.entitlement, c);
    await w.writeRow([entitlementId(plan, e), entitlementDisplayName(plan, e), c.directory ? 'Group' : 'Entitlement',
      entitlementDescription(e, plan.keys.name), c.name, 'true', value]);
  }
  for (let r = 0; r < plan.params.roles; r++) {
    const a = userAttributes(r, plan.keys.name);
    await w.writeRow([roleId(plan, r), `BR ${a.department} ${a.jobTitle} ${String(r + 1).padStart(5, '0')}`, 'BusinessRole',
      `Business role for ${a.jobTitle}, ${a.department}`, IDENTITY_STORE.name, 'true', '']);
  }
  return finish(w, 'Resources.csv');
}

export async function writeContextMembers(plan, dir, opts) {
  const w = open(dir, 'ContextMembers.csv', HEADERS.contextMembers, opts);
  for (let e = 0; e < plan.params.entitlements; e++) {
    await w.writeRow([applicationId(plan, plan.entApp[e]), entitlementId(plan, e), 'Resource']);
  }
  return finish(w, 'ContextMembers.csv');
}

export function principalDisplayName(plan, i) {
  const src = collisionSource(i, plan.keys.principal, plan.params.nameCollisionShare);
  return src < 0 ? userName(i, plan.keys.name).display : nearCollision(userName(src, plan.keys.name).display, i);
}

// The first ~8% of principals are the manager pool; everyone reports to an
// earlier member of it, so the hierarchy has no cycles.
function managerOf(i, poolSize, key) {
  if (i === 0) return -1;
  return fmix32((i ^ key) >>> 0) % Math.min(i, poolSize);
}

export async function writeUsers(plan, dir, opts) {
  const w = open(dir, 'Users.csv', HEADERS.users, opts);
  const pool = Math.max(1, Math.round(plan.params.principals * 0.08));
  for (let i = 0; i < plan.params.principals; i++) {
    const n = userName(i, plan.keys.name);
    const a = userAttributes(i, plan.keys.name);
    const m = managerOf(i, pool, plan.keys.principal);
    const email = `${n.first}.${n.last}.${i + 1}@example.com`.toLowerCase();
    const row = [principalId(plan, i), principalDisplayName(plan, i), email, 'User', a.jobTitle, a.department,
      m < 0 ? '' : principalId(plan, m), IDENTITY_STORE.name, plan.enabled[i] ? 'true' : 'false', a.employeeType];
    await w.writeRow(row);
  }
  return finish(w, 'Users.csv');
}

// Holders of one entitlement: `count` distinct principals, walked from a random
// start with a stride coprime to the principal count. O(1) memory per resource.
async function writeHolders(w, prefix, suffix, count, principalIds, rng) {
  const n = principalIds.length;
  const stride = coprimeStride(n, rng);
  let p = rng.int(n);
  for (let j = 0; j < count; j++) {
    if (w.append(prefix + principalIds[p] + suffix)) await w.flush();
    p += stride;
    if (p >= n) p -= n;
  }
}

export async function writeAssignments(plan, dir, opts) {
  const w = open(dir, 'Assignments.csv', HEADERS.assignments, opts);
  const d = w.delimiter;
  const rng = stream(plan.params.seed, 'assignments');
  const principalIds = Array.from({ length: plan.params.principals }, (_, i) => formatField(principalId(plan, i), d));
  for (let e = 0; e < plan.params.entitlements; e++) {
    const sys = formatField(plan.connectors[plan.entConnector[e]].name, d);
    await writeHolders(w, entitlementId(plan, e) + d, `${d}Direct${d}${sys}\n`, plan.entHolders[e], principalIds, rng);
  }
  const iga = formatField(IDENTITY_STORE.name, d);
  for (let r = 0; r < plan.params.roles; r++) {
    await writeHolders(w, roleId(plan, r) + d, `${d}Direct${d}${iga}\n`, plan.roleHolders[r], principalIds, rng);
  }
  return finish(w, 'Assignments.csv');
}
