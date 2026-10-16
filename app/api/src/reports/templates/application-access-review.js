// Entitlement Pivot (built as an access review pack): the entitlements a
// context holds, and who holds them.
//
// An owner is accountable for who can reach "their" thing — a logical
// application, a department's file shares, everything tagged PCI. In Identity
// Atlas that thing is a Context whose members are resources. This report lists
// those resources, one row per entitlement, with how many people hold each one
// directly and how many through a business role, and which roles those are.
// When a role grants an entitlement, the role's policy manages who holds it, so
// the split is what decides what an owner has to review — an entitlement with
// one direct holder is almost always an admin or a service account, and "45,000
// holders, 44,200 of them through roles" leads to the opposite decision from
// "45,000 direct".
//
// Everything else on the row is the reader's choice. The columns between the
// entitlement and its counts are FIELDS picked when the report is run — the
// context's own facts, the resource's, or any attribute either one's source
// stored — and so are the rows and filters of the two pivot tables the xlsx
// download opens with. Nothing here names a customer's attribute; see
// ../accessReviewFields.js for what a field is.
//
// Measured shape this is designed for (a large IdentityIQ-style deployment):
// ~800k entitlements, the largest single application ~39k of them, ~46M
// assignments. Hence: export is the primary artefact, and the counts are
// set-based aggregates over an explicit id ARRAY rather than a CTE sub-select
// the planner has to guess the size of. That last one is worth 12× on measured
// data and needs no new index — see docs/architecture/reports.md -> "Counting
// assignments at scale".

import * as db from '../../db/connection.js';
import { OWNERSHIP_RELATIONSHIP_TYPES_SQL, OWNERSHIP_TYPES_SQL } from '../../lib/ownershipTypes.js';
import { MAX_LIST, parseList, resolveFields } from '../accessReviewFields.js';

export { parseList };

// The row cap. The largest application measured on a production catalogue holds
// 39,072 entitlements; a request naming every context would otherwise pull the
// whole catalogue into one response. A capped run says so (`truncated`), because
// presenting the first N rows as the answer is the one thing a review pack may
// not do.
export const MAX_ROWS = 50000;

// A review is held per context; 500 is already far past any real request.
export const MAX_CONTEXTS = MAX_LIST;

// What a run shows when nobody picked anything: facts every deployment has.
export const DEFAULT_FIELDS = ['context.name', 'entitlement.type', 'entitlement.system', 'entitlement.owner'];
// The owner conversation's own breakdown: per context, per entitlement owner.
export const DEFAULT_PIVOT_ROWS = ['context.name', 'entitlement.owner'];

// The columns every run has, whatever was picked: what is being reviewed, and
// the split that decides how. The picked fields go between them.
const LEADING_COLUMNS = [{ key: 'entitlement', label: 'Entitlement' }];
const TRAILING_COLUMNS = [
  { key: 'businessRoles', label: 'Granted by role(s)' },
  { key: 'directAssignments', label: 'Users assigned directly' },
  { key: 'viaRoleAssignments', label: 'Users assigned via a role' },
];

const FIELD_LOOKUP = {
  'x-lookup': 'access-review-fields',
  // The attributes on offer are the ones the picked contexts actually carry.
  'x-lookupDependsOn': ['contexts'],
  'x-lookupPlaceholder': 'Search fields and attributes…',
};

/**
 * The run's columns and pivots from the fields it was asked for.
 *
 * A pivot can only read what the table holds, so a field used in a pivot is a
 * column even when it was not picked as one. One field cannot sit on two axes
 * of one pivot, so a filter that is also a row of that pivot is left off it.
 */
export function buildLayout({ fields, pivotRows, pivotFilters }) {
  const picked = [...fields];
  for (const field of [...pivotRows, ...pivotFilters]) {
    if (!picked.some(f => f.key === field.key)) picked.push(field);
  }
  const columns = [...LEADING_COLUMNS, ...picked.map(({ key, label }) => ({ key, label })), ...TRAILING_COLUMNS];

  const rowKeys = pivotRows.map(f => f.key);
  const filterKeys = pivotFilters.map(f => f.key);
  const directRows = [...rowKeys, 'entitlement'];
  const roleRows = ['businessRoles', 'entitlement'];
  const pivots = [
    {
      // `viaRoleAssignments` as a filter answers "which of these does no role
      // hand out" — pick 0 — without leaving the pivot.
      name: 'Direct assignments',
      filters: [...filterKeys, 'viaRoleAssignments'].filter(k => !directRows.includes(k)),
      rows: directRows,
      values: ['directAssignments'],
    },
    {
      name: 'Assignments via roles',
      filters: filterKeys.filter(k => !roleRows.includes(k)),
      rows: roleRows,
      values: ['viaRoleAssignments'],
    },
  ];
  return { fields: picked, columns, pivots };
}

// What a run with every parameter left at its default looks like — declared as
// the report's metadata, so the list page and an untouched run agree.
const DEFAULT_LAYOUT = buildLayout({
  fields: resolveFields(DEFAULT_FIELDS).fields,
  pivotRows: resolveFields(DEFAULT_PIVOT_ROWS).fields,
  pivotFilters: [],
});

export default {
  // The slug predates the rename and stays: saved views and bookmarked report
  // tabs address the report by it. Only the name people see changed.
  name: 'application-access-review',
  displayName: 'Entitlement Pivot',
  description:
    'One row per entitlement of one or more contexts — a logical application, a department\'s '
    + 'resources, a tag — with how many people hold it directly and how many through a business '
    + 'role. You choose the columns, and the rows and filters of the two pivot tables the Excel '
    + 'download opens with.',
  form: 'list',
  parametersSchema: {
    type: 'object',
    required: ['contexts'],
    properties: {
      contexts: {
        type: 'array',
        title: 'Contexts',
        description: 'Whose resources to review. Any context of resources works: a logical application, '
          + 'a department, a tag. Picking from the list stores the context\'s id, so a name shared by '
          + 'several contexts cannot select all of them by accident.',
        'x-lookup': 'resource-contexts',
        'x-lookupPlaceholder': 'Search contexts…',
        'x-step': 'Scope',
      },
      fields: {
        type: 'array',
        title: 'Columns',
        description: 'Shown between the entitlement and its assignment counts, in the order picked. '
          + 'The attributes on offer are the ones the picked contexts and their resources carry.',
        default: DEFAULT_FIELDS,
        ...FIELD_LOOKUP,
        'x-step': 'Columns',
      },
      pivotRows: {
        type: 'array',
        title: 'Pivot rows (Excel)',
        description: 'How the "Direct assignments" pivot is broken down, outermost first. The '
          + 'entitlement is always the innermost row.',
        default: DEFAULT_PIVOT_ROWS,
        ...FIELD_LOOKUP,
        'x-step': 'Excel pivots',
      },
      pivotFilters: {
        type: 'array',
        title: 'Pivot filters (Excel)',
        description: 'Fields both pivots can be filtered on.',
        default: [],
        ...FIELD_LOOKUP,
        'x-step': 'Excel pivots',
      },
    },
  },
  columns: DEFAULT_LAYOUT.columns,
  pivots: DEFAULT_LAYOUT.pivots,

  async run(params, ctx) {
    // `applications` is what the parameter was called while this report only
    // knew logical applications; a bookmark from then still opens.
    const wanted = parseList(params?.contexts ?? params?.applications, MAX_CONTEXTS);
    if (wanted.length === 0) return noContextsNamed();

    const picks = fieldParameters(params);
    const layout = buildLayout(picks);
    const contexts = await resolveContexts(wanted);
    const notices = [...contextNotices(wanted, contexts), ...picks.notices];
    const shape = { columns: layout.columns, pivots: layout.pivots };
    if (contexts.length === 0) return { rows: [], notices, ...shape };

    const entitlements = await fetchEntitlements(contexts.map(c => c.id));
    const truncated = entitlements.length > MAX_ROWS;
    const capped = truncated ? entitlements.slice(0, MAX_ROWS) : entitlements;
    if (capped.length === 0) {
      notices.push({
        severity: 'info',
        text: `${describe(contexts)} has no resources as members. Either nothing has been synced for it `
          + 'yet, or it groups something other than resources.',
      });
      return { rows: [], notices, ...shape };
    }

    const ids = capped.map(e => e.id);
    const [counts, roles, owners, users] = await Promise.all([
      fetchAssignmentCounts(ids), fetchRoles(ids), fetchOwners(ids), fetchUserTotal(ids),
    ]);

    const byContext = new Map(contexts.map(c => [c.id, c]));
    const rows = capped
      .map(e => ({
        entitlement: e,
        context: byContext.get(e.contextId),
        count: counts.get(e.id),
        roles: roles.get(e.id) || null,
        owner: owners.get(e.id),
      }))
      .sort(compareSources)
      .map(source => buildRow(layout.fields, source));

    const eligible = [...counts.values()].reduce((sum, c) => sum + (c.eligible || 0), 0);
    notices.push(...summaries(rows, { users, eligible }, contexts, owners));
    notices.push(...emptyFieldNotices(rows, layout.fields));
    if (truncated) {
      notices.push({
        severity: 'warning',
        text: `${describe(contexts)} holds ${entitlements.length.toLocaleString('en-US')} entitlements; this `
          + `run shows the first ${MAX_ROWS.toLocaleString('en-US')}. Run it per context to see all of them.`,
      });
    }

    ctx?.log?.(`access review report: ${rows.length} entitlement(s) across ${contexts.length} context(s)`);
    // One context resolved — not one NAME asked for. A name that matches three
    // contexts resolves to three, and their details differ per row.
    const constantColumns = contexts.length === 1
      ? layout.fields.filter(f => f.key.startsWith('context.')).map(f => f.key)
      : [];
    return { rows, notices, truncated, constantColumns, ...shape };
  },
};

// ─── Parameters ───────────────────────────────────────────────────────────

/**
 * The three field lists a run was given, resolved — each falling back to its
 * default when it was not sent — plus a warning naming any key that is not a
 * field. A key like that comes from an old bookmark or a hand-edited URL; it is
 * left out rather than failing the run.
 */
export function fieldParameters(params) {
  const list = (value, fallback) => {
    const keys = parseList(value);
    return keys.length ? keys : fallback;
  };
  const fields = resolveFields(list(params?.fields, DEFAULT_FIELDS));
  const pivotRows = resolveFields(list(params?.pivotRows, DEFAULT_PIVOT_ROWS));
  const pivotFilters = resolveFields(list(params?.pivotFilters, []));
  const unknown = [...new Set([...fields.unknown, ...pivotRows.unknown, ...pivotFilters.unknown])];
  return {
    fields: fields.fields,
    pivotRows: pivotRows.fields,
    pivotFilters: pivotFilters.fields,
    notices: unknown.length
      ? [{ severity: 'warning', text: `Left out ${unknown.map(k => `"${k}"`).join(', ')}: not a field this report knows.` }]
      : [],
  };
}

// ─── Resolving the contexts ───────────────────────────────────────────────

// Any context whose members are resources. Matched against the two things a
// person can reasonably have to hand: the name they see, and the id a picker or
// a deep link carries. Name matching is case-insensitive because a catalogue and
// the people reading it never agree on capitals.
async function resolveContexts(wanted) {
  const names = wanted.map(w => w.toLowerCase());
  const { rows } = await db.query(
    `SELECT c.id, c."displayName", c."contextType", c.description, c."ownerUserId", c."extendedAttributes",
            p."displayName" AS "ownerName"
       FROM "Contexts" c
       LEFT JOIN LATERAL (
            SELECT pr."displayName"
              FROM "Principals" pr
             WHERE pr."deletedAt" IS NULL
               AND (pr."externalId" = c."ownerUserId" OR pr."employeeId" = c."ownerUserId")
             ORDER BY (pr."externalId" = c."ownerUserId") DESC
             LIMIT 1) p ON TRUE
      WHERE c."targetType" = 'Resource'
        AND (lower(c."displayName") = ANY($1::text[]) OR c.id::text = ANY($1::text[]))
      ORDER BY c."displayName"`, [names]);
  return rows;
}

// What the run could not do with what it was given. Both cases are warnings
// rather than silence: an empty table is indistinguishable from "that name is
// spelled differently in the catalogue".
function contextNotices(wanted, contexts) {
  const notices = [];
  const found = new Set(contexts.flatMap(c => [c.displayName.toLowerCase(), c.id.toLowerCase()]));
  const missing = wanted.filter(w => !found.has(w.toLowerCase()));
  if (missing.length) {
    notices.push({
      severity: 'warning',
      text: `No context of resources matches ${missing.map(m => `"${m}"`).join(', ')}. `
        + 'Check the spelling against the Contexts page, or pick it from the list.',
    });
  }
  const counted = new Map();
  for (const c of contexts) {
    const key = c.displayName.toLowerCase();
    counted.set(key, (counted.get(key) || 0) + 1);
  }
  const ambiguous = [...counted].filter(([, n]) => n > 1).map(([name]) => name);
  if (ambiguous.length) {
    notices.push({
      severity: 'warning',
      text: `${ambiguous.length} name(s) match more than one context `
        + `(${ambiguous.join(', ')}); all of them are included. Pick from the list to choose one.`,
    });
  }
  return notices;
}

function noContextsNamed() {
  return {
    rows: [],
    notices: [{
      severity: 'info',
      text: 'Pick one or more contexts to review. A run over every context at once is not offered: '
        + 'an access review is held per context, with its owner.',
    }],
  };
}

const describe = contexts => (contexts.length === 1 ? `"${contexts[0].displayName}"` : `${contexts.length} contexts`);

// ─── The five data reads ─────────────────────────────────────────────────

// Every read after this one takes the entitlement ids as an explicit uuid[].
// That is not cosmetic: fed the same set as a CTE sub-select, the planner has no
// row estimate for it, falls back to its default, picks a merge join and scans
// the whole assignment table. Measured on the same 4.97M-row data, same result:
// 12,478 ms as a CTE against 809 ms as an array.
//
// Any resource type: a context groups whatever its source put in it, and the
// type is a column the reader can pick rather than a filter decided here.
async function fetchEntitlements(contextIds) {
  const { rows } = await db.query(
    `SELECT r.id, r."displayName", r."resourceType", r.description, r."extendedAttributes",
            s."displayName" AS "systemName", cm."contextId"
       FROM "ContextMembers" cm
       JOIN "Resources" r ON r.id = cm."memberId"
       LEFT JOIN "Systems" s ON s.id = r."systemId"
      WHERE cm."contextId" = ANY($1::uuid[])
        AND cm."memberType" = 'Resource'
        AND r."deletedAt" IS NULL
      ORDER BY r."displayName", r.id
      LIMIT ${MAX_ROWS + 1}`, [contextIds]);
  return rows;
}

// Holders per entitlement, split by how they hold it.
//
// De-duplicated per holder, because the governed model stores intent and actual
// as two assignment rows differing only in `governed`: a plain count(*) reports
// one person as two. `identityId` is the holder where a source links an
// identity rather than an account; exactly one of the two columns is set.
//
// The de-duplication is an inner DISTINCT rather than count(DISTINCT …) inside
// the aggregate. They return the same numbers; count(DISTINCT …) forces a
// sorted GroupAggregate and with it a random-access index scan, which measured
// 2,315 ms against this shape's 809 ms on the same 864,796 in-scope rows.
async function fetchAssignmentCounts(ids) {
  const { rows } = await db.query(
    `SELECT d.id,
            count(*) FILTER (WHERE d.t = 'Direct')::int   AS "direct",
            count(*) FILTER (WHERE d.t = 'Indirect')::int AS "indirect",
            count(*) FILTER (WHERE d.t = 'Eligible')::int AS "eligible"
       FROM (SELECT DISTINCT ra."resourceId" AS id,
                    COALESCE(ra."principalId", ra."identityId") AS h,
                    ra."assignmentType" AS t
               FROM "ResourceAssignments" ra
              WHERE ra."resourceId" = ANY($1::uuid[])
                AND ra."deletedAt" IS NULL) d
      GROUP BY d.id`, [ids]);
  return new Map(rows.map(r => [r.id, r]));
}

// The business roles that contain each entitlement. An entitlement may sit in
// several; all of them are named, because "which role do I talk to" is the
// question that column exists to answer.
async function fetchRoles(ids) {
  const { rows } = await db.query(
    `SELECT rr."childResourceId" AS id, string_agg(DISTINCT br."displayName", ', ') AS "roles"
       FROM "ResourceRelationships" rr
       JOIN "Resources" br ON br.id = rr."parentResourceId"
        AND br."resourceType" = 'BusinessRole'
        AND br."deletedAt" IS NULL
      WHERE rr."relationshipType" = 'Contains'
        AND rr."childResourceId" = ANY($1::uuid[])
      GROUP BY rr."childResourceId"`, [ids]);
  return new Map(rows.map(r => [r.id, r.roles]));
}

// Ownership is a link, never a column: a synthetic ownership resource named
// after the entitlement, a HasOwnership relationship to it, and a plain Direct
// assignment per owner. The person's name and mail come from the Principal, so
// the report shows a person rather than the identifier the source stored.
//
// One row per (entitlement, owner) rather than a pre-aggregated string, because
// "how many distinct people own anything here" cannot be recovered from an
// aggregate that has already collapsed each entitlement's owners.
async function fetchOwners(ids) {
  const { rows } = await db.query(
    `SELECT DISTINCT rr."parentResourceId" AS id, p.id AS "ownerId",
            p."displayName" AS "ownerName", p.email AS "ownerEmail"
       FROM "ResourceRelationships" rr
       JOIN "Resources" o ON o.id = rr."childResourceId"
        AND o."resourceType" IN ${OWNERSHIP_TYPES_SQL}
        AND o."deletedAt" IS NULL
       JOIN "ResourceAssignments" ra ON ra."resourceId" = o.id
        AND ra."assignmentType" = 'Direct'
        AND ra."deletedAt" IS NULL
       JOIN "Principals" p ON p.id = ra."principalId" AND p."deletedAt" IS NULL
      WHERE rr."relationshipType" IN ${OWNERSHIP_RELATIONSHIP_TYPES_SQL}
        AND rr."parentResourceId" = ANY($1::uuid[])
      ORDER BY rr."parentResourceId", p."displayName"`, [ids]);
  return groupOwners(rows);
}

/**
 * `(entitlement, owner)` rows folded into one entry per entitlement, keeping the
 * owner ids so the distinct-owner summary counts people rather than links.
 * An entitlement with two owners shows both, comma-separated.
 */
export function groupOwners(rows) {
  const byEntitlement = new Map();
  for (const row of rows) {
    const entry = byEntitlement.get(row.id)
      || { names: [], emails: [], ids: new Set() };
    if (row.ownerName) entry.names.push(row.ownerName);
    if (row.ownerEmail) entry.emails.push(row.ownerEmail);
    entry.ids.add(row.ownerId);
    byEntitlement.set(row.id, entry);
  }
  return new Map([...byEntitlement].map(([id, e]) => [id, {
    ownerName: e.names.join(', ') || null,
    ownerEmail: e.emails.join(', ') || null,
    ownerIds: [...e.ids],
  }]));
}

// The one number that cannot be summed from the per-entitlement counts: a
// person holding ten entitlements is one user. Same DISTINCT-as-a-subquery
// reason as above — as count(DISTINCT …) this measured 1,014 ms with a 41 MB
// on-disk sort, against 313 ms hash-aggregated.
async function fetchUserTotal(ids) {
  const row = await db.queryOne(
    `SELECT count(*)::int AS "users"
       FROM (SELECT DISTINCT COALESCE(ra."principalId", ra."identityId") AS h
               FROM "ResourceAssignments" ra
              WHERE ra."resourceId" = ANY($1::uuid[])
                AND ra."deletedAt" IS NULL) s`, [ids]);
  return row?.users ?? 0;
}

// ─── Shaping ──────────────────────────────────────────────────────────────

/**
 * One row: the entitlement, every picked field, then the role split.
 *
 * The context's picked facts repeat on every one of its rows on purpose: notices
 * are screen-only, and the CSV is the artefact that gets mailed to someone with
 * no access to this screen. A file that does not say what it describes is not
 * reviewable. The xlsx states them once instead, when the run covers one context.
 */
export function buildRow(fields, source) {
  const row = { entitlement: source.entitlement.displayName };
  for (const field of fields) {
    const value = field.read(source);
    row[field.key] = value === undefined || value === '' ? null : value;
  }
  row.businessRoles = source.roles;
  row.directAssignments = source.count?.direct ?? 0;
  row.viaRoleAssignments = source.count?.indirect ?? 0;
  row._entity = { kind: 'resource', id: source.entitlement.id };
  return row;
}

/**
 * By context, then by entitlement name, so two runs of the same report compare
 * — sorted on the sources, because the context name need not be a column.
 */
export function compareSources(a, b) {
  return String(a.context?.displayName ?? '').localeCompare(String(b.context?.displayName ?? ''))
    || String(a.entitlement.displayName ?? '').localeCompare(String(b.entitlement.displayName ?? ''));
}

// ─── The summaries ────────────────────────────────────────────────────────

/** `n` as a share of `total`, one decimal, or 0 when there is nothing to divide. */
export function percentage(n, total) {
  return total > 0 ? Math.round((n / total) * 1000) / 10 : 0;
}

// Four statements about the rows, plus the one the data itself forces: holders
// that are neither direct nor via-role.
export function summaries(rows, scope, contexts, owners) {
  const total = rows.length;
  const inRole = rows.filter(r => r.businessRoles).length;
  const people = new Set([...owners.values()].flatMap(o => o.ownerIds));
  const unowned = rows.filter(r => !owners.has(r._entity.id)).length;

  const notices = [
    { severity: 'info', text: `${scope.users.toLocaleString('en-US')} unique user(s) hold at least one assignment in ${describe(contexts)}.` },
    { severity: 'info', text: `${total.toLocaleString('en-US')} entitlement(s) in scope.` },
    { severity: 'info', text: `${people.size.toLocaleString('en-US')} distinct entitlement owner(s); ${unowned.toLocaleString('en-US')} entitlement(s) have no owner.` },
    { severity: 'info', text: `${percentage(inRole, total)}% of entitlements are part of a business role (${inRole.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}).` },
  ];
  if (scope.eligible > 0) {
    notices.push({
      severity: 'warning',
      text: `${scope.eligible.toLocaleString('en-US')} holder(s) in scope are Eligible rather than Direct or `
        + 'Indirect, so they are in neither count column. That is access someone can activate on demand.',
    });
  }
  return notices;
}

/**
 * A picked attribute that no row carries. Said once, rather than left as an
 * empty column to puzzle over: it is either the wrong attribute for these
 * contexts, or a gap in the source worth closing.
 */
export function emptyFieldNotices(rows, fields) {
  const empty = fields.filter(f => f.attribute && rows.every(r => r[f.key] === null));
  if (!empty.length) return [];
  return [{
    severity: 'info',
    text: `No row in scope has a value for ${empty.map(f => `"${f.label}"`).join(', ')}.`,
  }];
}
