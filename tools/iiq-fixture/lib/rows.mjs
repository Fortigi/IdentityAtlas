// Row builders: the scale-dataset plan, written down the way IdentityIQ stores
// it. Every value that also appears in the CSV fixture (names, departments,
// managers, entitlement values, application names and owners, holder sets) is
// derived with the SAME function from the SAME plan, so the two fixtures are one
// dataset in two formats.

import crypto from 'node:crypto';
import { fmix32, hashLabel, stream } from '../../scale-dataset/lib/random.mjs';
import { userName, userAttributes, applicationName, entitlementValue, entitlementDescription, nearCollision } from '../../scale-dataset/lib/names.mjs';
import { entitlementDisplayName, principalDisplayName, managerOf, enabledPrincipalNear } from '../../scale-dataset/lib/emit.mjs';
import { idSpace, iiqId, timestamps, attributesXml } from './iiq.mjs';

// The attribute an entitlement lives under, per connector type.
const ATTRIBUTE_BY_TYPE = Object.freeze({
  LDAP: 'memberOf', ERP: 'roles', Database: 'privileges', SaaS: 'groups',
  Mainframe: 'profiles', ITSM: 'groups', FileShare: 'rights',
});
const COMPANIES = Object.freeze([['Example Holding', 'C100'], ['Example Operations', 'C200'], ['Example Services', 'C300'], ['Example Labs', 'C400']]);
const COUNTRIES = Object.freeze(['NL', 'NL', 'NL', 'US', 'US', 'DE', 'BE', 'FR', 'GB', 'SG', 'KR', 'TW', 'CN', 'JP']);
const CERT_FREQUENCIES = Object.freeze(['Quarterly', 'Semi-Annual', 'Annual', 'Annual']);
const EMPLOYEE_GROUPS = Object.freeze({ Employee: ['Internal', 'Permanent'], Contractor: ['External', 'Contractor'], Service: ['Internal', 'Service'], Temporary: ['External', 'Temporary'] });
const SECTORS = 12;
const DIVISIONS = 5;

const unit = (h) => h / 4294967296;
const pad = (n, w) => String(n).padStart(w, '0');

// The organisation above a department: sector (coarser) and division (coarsest).
// Deterministic in the department's name, so everyone in one department shares
// both, which is what a real hierarchy looks like.
export function orgOf(department) {
  const h = hashLabel(`org:${department}`);
  const sector = h % SECTORS;
  const division = sector % DIVISIONS;
  return {
    subdivcode: `SD${pad(hashLabel(department) % 10000, 4)}`, subdivtext: department,
    seccode: `SC${pad(sector + 1, 2)}`, sectext: `Sector ${String.fromCharCode(65 + sector)}`,
    divcode: `DV${pad(division + 1, 2)}`, divtext: `Division ${division + 1}`,
  };
}

export function makeContext(plan, iiq) {
  const seed = plan.params.seed;
  const spaces = Object.fromEntries(['application', 'identity', 'custom', 'entitlement', 'bundle', 'profile', 'relation', 'grant']
    .map(k => [k, idSpace(seed, k)]));
  const n = plan.params.principals;
  const identityIds = new Array(n);
  for (let i = 0; i < n; i++) identityIds[i] = iiqId(spaces.identity, i);
  return {
    plan, iiq, seed, spaces, identityIds,
    appIds: plan.connectors.map(c => iiqId(spaces.application, c.index)),
    managerPool: Math.max(1, Math.round(n * 0.08)),
  };
}

// spt_identity.name — the employee number: 8 digits, unique.
export const employeeNumber = (i) => String(10000000 + i);
export const userId = (ctx, i) => {
  const u = userName(i, ctx.plan.keys.name);
  return `${u.first[0]}${u.last}${i + 1}`.toLowerCase();
};
// The account on a directory connector is a distinguished name — commas again.
export function accountDn(ctx, i) {
  const u = userName(i, ctx.plan.keys.name);
  return `CN=${u.first} ${u.last} ${i + 1},OU=Users,OU=${COUNTRIES[fmix32(i) % COUNTRIES.length]},DC=corp,DC=example,DC=com`;
}

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

export function applicationRow(ctx, c) {
  const t = timestamps(ctx.seed, 'application', c.index, ctx.iiq.asOf, ctx.iiq.historyDays);
  return [ctx.appIds[c.index], t.created, t.modified, null, c.name, c.type, `sailpoint.connector.${c.type}Connector`, 0,
    attributesXml([['sysDescriptions', `Technical connector ${c.code}`]])];
}

export function identityRow(ctx, i) {
  const { plan, iiq } = ctx;
  const u = userName(i, plan.keys.name);
  const a = userAttributes(i, plan.keys.name);
  const org = orgOf(a.department);
  const enabled = plan.enabled[i] === 1;
  const t = timestamps(ctx.seed, 'identity', i, iiq.asOf, iiq.historyDays);
  const h = fmix32((i ^ 0x3c6ef372) >>> 0);
  const [companyname, companycode] = COMPANIES[h % COMPANIES.length];
  const [employeegroup, employeesubgroup] = EMPLOYEE_GROUPS[a.employeeType] ?? EMPLOYEE_GROUPS.Employee;
  const m = managerOf(i, ctx.managerPool, plan.keys.principal);
  return [
    ctx.identityIds[i], t.created, t.modified, null, employeeNumber(i), principalDisplayName(plan, i), u.first, u.last,
    `${u.first}.${u.last}.${i + 1}@example.com`.toLowerCase(), m < 0 ? null : ctx.identityIds[m],
    enabled ? 0 : 1, 0, 1, a.employeeType.toLowerCase(), t.modified, null,
    userId(ctx, i), `${u.first} ${u.last}`, a.jobTitle, companyname, companycode, pad(h % 100000, 5), `CC${pad((h >>> 8) % 10000, 4)}`,
    employeegroup, employeesubgroup, enabled ? 'Active' : 'Withdrawn', COUNTRIES[fmix32(i) % COUNTRIES.length], `L${pad((h >>> 12) % 500, 3)}`,
    org.divcode, org.divtext, org.seccode, org.sectext, org.subdivcode, org.subdivtext,
    isoDate(t.created), enabled ? null : isoDate(t.modified),
  ];
}

// Workgroups share spt_identity with people. Indexed after the principals.
export function workgroupRow(ctx, w) {
  const idx = ctx.plan.params.principals + w;
  const t = timestamps(ctx.seed, 'identity', idx, ctx.iiq.asOf, ctx.iiq.historyDays);
  const name = `WG ${ctx.plan.connectors[w % ctx.plan.connectors.length].code} Approvers ${pad(w + 1, 3)}`;
  const row = new Array(36).fill(null);
  Object.assign(row, { 0: iiqId(ctx.spaces.identity, idx), 1: t.created, 2: t.modified, 4: name, 5: name, 10: 0, 11: 1, 12: 0, 14: t.modified });
  return row;
}

// The logical application an entitlement names — with the configured share of
// case/trailing-space drift from the catalogue's spelling, or none at all.
export function entitlementAppName(ctx, e) {
  const { plan, iiq } = ctx;
  const h = fmix32((e ^ plan.keys.app ^ 0x7f4a7c15) >>> 0);
  if (unit(h) < iiq.unassignedAppShare) return null;
  const name = applicationName(plan.entApp[e], plan.keys.name);
  return unit(fmix32(h)) < iiq.appNameDriftShare ? nearCollision(name, e) : name;
}

// Per-entitlement facts the grant rows repeat 40M times: computed once.
export function entitlementFacts(ctx, e) {
  const { plan } = ctx;
  const c = plan.connectors[plan.entConnector[e]];
  return {
    id: iiqId(ctx.spaces.entitlement, e),
    appId: ctx.appIds[c.index],
    attribute: ATTRIBUTE_BY_TYPE[c.type] ?? 'entitlements',
    value: entitlementValue(e, plan.keys.entitlement, c),
    displayName: entitlementDisplayName(plan, e),
    directory: c.directory,
  };
}

export function managedAttributeRow(ctx, e) {
  const { plan, iiq } = ctx;
  const f = entitlementFacts(ctx, e);
  const t = timestamps(ctx.seed, 'entitlement', e, iiq.asOf, iiq.historyDays);
  const h = fmix32((e ^ 0x165667b1) >>> 0);
  const owner = unit(h) < iiq.ownedShare ? ctx.identityIds[fmix32(h) % plan.params.principals] : null;
  const hash = crypto.createHash('sha1').update(`${f.appId}|${f.attribute}|${f.value}`).digest('hex');
  const xml = attributesXml([[iiq.appNameKey, entitlementAppName(ctx, e)], ['sysDescriptions', entitlementDescription(e, plan.keys.name)]]);
  const flag = (bits) => ((h >>> bits) & 1 ? 'true' : 'false');
  return [
    f.id, t.created, t.modified, owner, f.appId, 'Entitlement', f.attribute, f.value, hash, f.displayName,
    (h >>> 3) & 1, 1, 0, t.modified, xml,
    flag(4), CERT_FREQUENCIES[(h >>> 5) % CERT_FREQUENCIES.length], `CC${pad((h >>> 8) % 10000, 4)}`,
    flag(20), flag(21), flag(22), flag(23), (h >>> 24) % 17 === 0 ? 'true' : 'false',
  ];
}

// One spt_identity_entitlement row: entitlement facts × holder × grant sequence.
export function grantRow(ctx, f, p, seq) {
  const { iiq } = ctx;
  const t = timestamps(ctx.seed, 'grant', seq, iiq.asOf, iiq.historyDays);
  const h = fmix32((seq ^ 0x61c88647) >>> 0);
  const byRole = unit(h) < iiq.roleGrantedShare;
  const requested = !byRole && unit(fmix32(h)) < iiq.requestedShare;
  return [
    iiqId(ctx.spaces.grant, seq), t.created, t.modified, null, ctx.identityIds[p], f.appId,
    f.directory ? accountDn(ctx, p) : userId(ctx, p), null, f.attribute, f.value, f.displayName, null,
    'Entitlement', 'Connected', byRole ? 'Role' : (requested ? 'LCM' : 'Aggregation'),
    requested ? 1 : 0, 0, byRole ? 1 : 0, requested ? employeeNumber(p) : null, requested ? iiqId(ctx.spaces.relation, seq) : null,
    null, null, null,
  ];
}

export const roleName = (ctx, r) => {
  const a = userAttributes(r, ctx.plan.keys.name);
  return `BR ${a.department} ${a.jobTitle} ${pad(r + 1, 5)}`;
};

export function bundleRow(ctx, r) {
  const t = timestamps(ctx.seed, 'bundle', r, ctx.iiq.asOf, ctx.iiq.historyDays);
  const a = userAttributes(r, ctx.plan.keys.name);
  const name = roleName(ctx, r);
  const owner = ctx.identityIds[fmix32((r ^ 0x2545f491) >>> 0) % ctx.plan.params.principals];
  return [iiqId(ctx.spaces.bundle, r), t.created, t.modified, owner, name, name, name, 'business', 0,
    attributesXml([['sysDescriptions', `Business role for ${a.jobTitle}, ${a.department}`]])];
}

// The entitlements a role grants, as spt_bundle_profile_relation rows. The
// relation carries application + attribute + value — the same three columns the
// grant rows join on — as well as the display value a name-based join would use.
export function profileRelationRows(ctx, r, seqStart) {
  const { plan, iiq } = ctx;
  const span = iiq.roleSizeMax - iiq.roleSizeMin + 1;
  const k = Math.min(plan.params.entitlements, iiq.roleSizeMin + (fmix32((r ^ 0x1b873593) >>> 0) % span));
  const bundleId = iiqId(ctx.spaces.bundle, r);
  const t = timestamps(ctx.seed, 'bundle', r, iiq.asOf, iiq.historyDays);
  const chosen = new Set();
  for (let j = 0; chosen.size < k && j < k * 20; j++) chosen.add(fmix32(((r * 131) + j) ^ 0xcc9e2d51) % plan.params.entitlements);
  const rows = [];
  for (const e of chosen) {
    const f = entitlementFacts(ctx, e);
    rows.push([iiqId(ctx.spaces.relation, seqStart + rows.length), t.created, t.modified, bundleId, bundleId,
      iiqId(ctx.spaces.profile, r), f.appId, f.attribute, f.value, f.displayName, 'Entitlement', 0]);
  }
  return rows;
}

// The catalogue entries, in application order, drawing owner and CMDB reference
// from the same stream as the CSV fixture's Contexts.csv.
export function catalogEntries(ctx) {
  const { plan, iiq } = ctx;
  const rng = stream(plan.params.seed, 'contexts');
  const out = [];
  for (let a = 0; a < plan.params.logicalApplications; a++) {
    const owner = enabledPrincipalNear(plan, rng.int(plan.params.principals));
    const cmdb = `CI${String(1000000 + rng.int(8999999)).padStart(7, '0')}`;
    const name = applicationName(a, plan.keys.name);
    const home = plan.connectors[plan.apps.homes[a]];
    const values = [
      name.split(' ').map(w => w[0]).join('') + pad(a + 1, 4), employeeNumber(owner), cmdb, home.type,
      `Logical application ${name}, spans ${1 + plan.apps.secondaries[a].length} connector(s)`,
      orgOf(userAttributes(a, plan.keys.name).department).sectext, employeeNumber(owner),
    ];
    out.push({ name, fields: iiq.catalogKeys.map((k, i) => [k, values[i] ?? null]) });
  }
  return out;
}
