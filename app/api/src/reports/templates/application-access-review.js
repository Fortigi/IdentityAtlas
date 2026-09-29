// Access review pack for a logical application owner.
//
// A logical application owner is accountable for who can reach their
// application. They do not run the review themselves: they decide, per
// entitlement, whether it is worth reviewing and how often, and who the
// entitlement owner is. The entitlement owner then approves or denies the
// assignments. This report is what that first conversation is held over.
//
// Two distinctions decide what an owner looks at, and they are the reason the
// rows carry a `section` rather than being three reports:
//
//   * Requestable or not. An entitlement people can ask for is one the owner
//     has to make a decision about; one nobody can ask for is information.
//   * Part of a business role or not. When a role grants an entitlement, the
//     role's policy manages who holds it, so reviewing it at entitlement level
//     reviews nothing. Role membership therefore WINS over requestable.
//
// The assignment counts are split Direct / Indirect on purpose. "45,000
// assignments, 44,200 of them through roles" and "45,000 direct" lead to
// opposite decisions, and an entitlement with one holder is almost always an
// admin or service account. Splitting is the whole value of the column.
//
// Measured shape this is designed for (a large IdentityIQ-style deployment):
// ~800k entitlements, the largest single application ~39k of them, ~46M
// assignments, 96.7% of entitlements with NO certification frequency, and a
// dirty frequency vocabulary. Hence: export is the primary artefact, "Not set"
// is a value rather than a blank, raw values are never normalised, and the
// counts are set-based aggregates over an explicit id ARRAY rather than a CTE
// sub-select the planner has to guess the size of. That last one is worth 12×
// on measured data and needs no new index — see
// docs/architecture/reports.md -> "Counting assignments at scale".

import * as db from '../../db/connection.js';
import { OWNERSHIP_RELATIONSHIP_TYPES_SQL, OWNERSHIP_TYPES_SQL } from '../../lib/ownershipTypes.js';

// The row cap. The largest application measured on a production catalogue holds
// 39,072 entitlements; a request naming every application would otherwise pull
// the whole catalogue into one response. A capped run says so (`truncated`),
// because presenting the first N rows as the answer is the one thing a review
// pack may not do.
export const MAX_ROWS = 50000;

// The three mutually exclusive buckets, worded as the owner reads them.
export const SECTION_REQUESTABLE = 'requestable, not in a role';
export const SECTION_NOT_REQUESTABLE = 'not requestable, not in a role';
export const SECTION_IN_ROLE = 'part of a role';

// Screen order: what the owner must act on first, then the information-only
// rows, then the ones a role already manages.
const SECTION_ORDER = [SECTION_REQUESTABLE, SECTION_NOT_REQUESTABLE, SECTION_IN_ROLE];

// A certification frequency that was never set. A first-class value, not a
// blank cell: closing this gap is the point of the exercise, so it has to be
// countable and filterable in the export.
export const FREQUENCY_NOT_SET = 'Not set';

// Two frequency spellings this close apart are the same intent typed twice
// ('Quarterly' / 'Quaterly'). Anything further apart is left alone — 'Monthly'
// and 'Annually' are not a data-quality problem.
const NEAR_DUPLICATE_DISTANCE = 2;

/**
 * A list parameter, however it arrived: `?applications=a,b` is one string,
 * `applications[]=a&applications[]=b` is an array, and the form sends the
 * comma-joined form. Blank entries are dropped rather than matched.
 */
export function parseList(value) {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(',');
  return parts.map(v => String(v ?? '').trim()).filter(Boolean);
}

/**
 * Whether a source's `requestable` attribute means yes. Sources write this as a
 * SQL bit (1/0), a boolean, or a string, so a bare truthiness test would call
 * the string "0" requestable. Anything unrecognised is NOT requestable, which
 * is the safe default: it puts the entitlement in the information-only section
 * instead of on the owner's action list.
 */
export function isRequestable(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value ?? '').trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'y' || text === 'yes';
}

/**
 * The certification frequency exactly as the source stores it, or `Not set`.
 * Deliberately NOT normalised: an owner who typed a value has to see the value
 * they typed, misspelling included, or they cannot correct it. The near-
 * duplicate spellings are reported separately, as a notice.
 */
export function certificationFrequency(value) {
  const text = String(value ?? '').trim();
  return text || FREQUENCY_NOT_SET;
}

/** Levenshtein distance, capped: only used on the handful of distinct frequency values. */
export function editDistance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * Pairs of stored frequency values that differ only by a typo or by case, as
 * `"a" / "b"` strings. `Not set` never pairs with anything — it is this
 * report's own word, not a stored value.
 */
export function nearDuplicateFrequencies(values) {
  const distinct = [...new Set(values)].filter(v => v !== FREQUENCY_NOT_SET).sort();
  const pairs = [];
  for (let i = 0; i < distinct.length; i++) {
    for (let j = i + 1; j < distinct.length; j++) {
      const a = distinct[i];
      const b = distinct[j];
      const same = a.toLowerCase() === b.toLowerCase();
      if (same || editDistance(a.toLowerCase(), b.toLowerCase()) <= NEAR_DUPLICATE_DISTANCE) {
        pairs.push(`"${a}" / "${b}"`);
      }
    }
  }
  return pairs;
}

/** `n` as a share of `total`, one decimal, or 0 when there is nothing to divide. */
export function percentage(n, total) {
  return total > 0 ? Math.round((n / total) * 1000) / 10 : 0;
}

/**
 * The first of `keys` the object actually carries, as a trimmed string or null.
 * The catalogue field names are deployment-specific — one installation writes
 * `onboardingArea`, another `onboardingSector` — so each is read through the
 * spellings that have been seen rather than one guess that silently returns
 * nothing.
 */
export function pickAttribute(attrs, keys) {
  for (const key of keys) {
    const value = attrs?.[key];
    const text = value === null || value === undefined ? '' : String(value).trim();
    if (text) return text;
  }
  return null;
}

// How one row's section is decided. Exported so the rule is testable without a
// database: role membership wins, and only then does requestable split the rest.
export function sectionFor({ roles, requestable }) {
  if (roles) return SECTION_IN_ROLE;
  return requestable ? SECTION_REQUESTABLE : SECTION_NOT_REQUESTABLE;
}

export default {
  name: 'application-access-review',
  displayName: 'Application Access Review',
  description:
    'One row per entitlement of a logical application, split into what the application owner '
    + 'must review (requestable, not granted by a business role), what is information only, and '
    + 'what a business role already manages. Carries the certification frequency and entitlement '
    + 'owner as stored, and how many people hold the entitlement directly versus through a role.',
  form: 'list',
  parametersSchema: {
    type: 'object',
    required: ['applications'],
    properties: {
      applications: {
        type: 'array',
        title: 'Logical applications',
        description: 'One or more logical applications, by name or by id, comma-separated.',
      },
    },
  },
  columns: [
    { key: 'entitlement', label: 'Entitlement' },
    { key: 'section', label: 'Section' },
    { key: 'requestable', label: 'Requestable' },
    { key: 'certificationFrequency', label: 'Certification frequency' },
    { key: 'entitlementOwner', label: 'Entitlement owner' },
    { key: 'entitlementOwnerEmail', label: 'Entitlement owner email' },
    { key: 'businessRoles', label: 'Granted by role(s)' },
    { key: 'directAssignments', label: 'Users assigned directly' },
    { key: 'viaRoleAssignments', label: 'Users assigned via a role' },
    { key: 'application', label: 'Application' },
    { key: 'applicationDescription', label: 'Application description' },
    { key: 'applicationOwner', label: 'Application owner' },
    { key: 'abbreviation', label: 'Abbreviation' },
    { key: 'cmdbReference', label: 'CMDB reference' },
    { key: 'connectionType', label: 'Connection type' },
    { key: 'onboardingSector', label: 'Onboarding sector' },
    { key: 'applicationManager', label: 'Application manager' },
  ],

  async run(params, ctx) {
    const wanted = parseList(params?.applications);
    if (wanted.length === 0) return noApplicationsNamed();

    const apps = await resolveApplications(wanted);
    const notices = applicationNotices(wanted, apps);
    if (apps.length === 0) return { rows: [], notices };

    const entitlements = await fetchEntitlements(apps.map(a => a.id));
    const truncated = entitlements.length > MAX_ROWS;
    const capped = truncated ? entitlements.slice(0, MAX_ROWS) : entitlements;
    if (capped.length === 0) {
      notices.push({
        severity: 'info',
        text: `${describe(apps)} has no entitlements loaded. Either nothing has been synced for it `
          + 'yet, or its entitlements are not members of the application context.',
      });
      return { rows: [], notices };
    }

    const ids = capped.map(e => e.id);
    const [counts, roles, owners, users] = await Promise.all([
      fetchAssignmentCounts(ids), fetchRoles(ids), fetchOwners(ids), fetchUserTotal(ids),
    ]);

    const byApp = new Map(apps.map(a => [a.id, a]));
    const rows = capped.map(e => buildRow(e, byApp.get(e.appId), counts, roles, owners));
    rows.sort(compareRows);

    const eligible = [...counts.values()].reduce((sum, c) => sum + (c.eligible || 0), 0);
    notices.push(...summaries(rows, { users, eligible }, apps, owners));
    if (truncated) {
      notices.push({
        severity: 'warning',
        text: `${describe(apps)} holds ${entitlements.length.toLocaleString('en-US')} entitlements; this `
          + `run shows the first ${MAX_ROWS.toLocaleString('en-US')}. Run it per application to see all of them.`,
      });
    }

    ctx?.log?.(`application-access-review report: ${rows.length} entitlement(s) across ${apps.length} application(s)`);
    return { rows, notices, truncated };
  },
};

// ─── Resolving the applications ───────────────────────────────────────────

// A logical application is a Context, so the parameter is matched against the
// two things a person can reasonably have to hand: the name they see, and the
// id a deep link carries. Name matching is case-insensitive because a catalogue
// and the people reading it never agree on capitals.
async function resolveApplications(wanted) {
  const names = wanted.map(w => w.toLowerCase());
  const { rows } = await db.query(
    `SELECT c.id, c."displayName", c.description, c."ownerUserId", c."extendedAttributes",
            p."displayName" AS "ownerName", p.email AS "ownerEmail"
       FROM "Contexts" c
       LEFT JOIN LATERAL (
            SELECT pr."displayName", pr.email
              FROM "Principals" pr
             WHERE pr."deletedAt" IS NULL
               AND (pr."externalId" = c."ownerUserId" OR pr."employeeId" = c."ownerUserId")
             ORDER BY (pr."externalId" = c."ownerUserId") DESC
             LIMIT 1) p ON TRUE
      WHERE c."contextType" = 'LogicalApplication'
        AND c."targetType" = 'Resource'
        AND (lower(c."displayName") = ANY($1::text[]) OR c.id::text = ANY($1::text[]))
      ORDER BY c."displayName"`, [names]);
  return rows;
}

// What the run could not do with what it was given. Both cases are warnings
// rather than silence: an empty table is indistinguishable from "that name is
// spelled differently in the catalogue".
function applicationNotices(wanted, apps) {
  const notices = [];
  const found = new Set(apps.flatMap(a => [a.displayName.toLowerCase(), a.id.toLowerCase()]));
  const missing = wanted.filter(w => !found.has(w.toLowerCase()));
  if (missing.length) {
    notices.push({
      severity: 'warning',
      text: `No logical application matches ${missing.map(m => `"${m}"`).join(', ')}. `
        + 'Check the spelling against the Contexts page, or name the application by its id.',
    });
  }
  const counted = new Map();
  for (const a of apps) {
    const key = a.displayName.toLowerCase();
    counted.set(key, (counted.get(key) || 0) + 1);
  }
  const ambiguous = [...counted].filter(([, n]) => n > 1).map(([name]) => name);
  if (ambiguous.length) {
    notices.push({
      severity: 'warning',
      text: `${ambiguous.length} name(s) match more than one logical application `
        + `(${ambiguous.join(', ')}); all of them are included. Name the application by its id to pick one.`,
    });
  }
  return notices;
}

function noApplicationsNamed() {
  return {
    rows: [],
    notices: [{
      severity: 'info',
      text: 'Name one or more logical applications to review. A run over every application at once '
        + 'is not offered: an access review is held per application, with its owner.',
    }],
  };
}

const describe = apps => (apps.length === 1 ? `"${apps[0].displayName}"` : `${apps.length} applications`);

// ─── The four data reads ──────────────────────────────────────────────────

// Every read after this one takes the entitlement ids as an explicit uuid[].
// That is not cosmetic: fed the same set as a CTE sub-select, the planner falls
// back to its default row estimate, picks a merge join and scans the whole
// assignment table — 12.5s where the array form takes 0.5s on the same data.
async function fetchEntitlements(appIds) {
  const { rows } = await db.query(
    `SELECT r.id, r."displayName", r."extendedAttributes", cm."contextId" AS "appId"
       FROM "ContextMembers" cm
       JOIN "Resources" r ON r.id = cm."memberId"
      WHERE cm."contextId" = ANY($1::uuid[])
        AND cm."memberType" = 'Resource'
        AND r."resourceType" = 'Entitlement'
        AND r."deletedAt" IS NULL
      ORDER BY r."displayName", r.id
      LIMIT ${MAX_ROWS + 1}`, [appIds]);
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
// question a section-3 row exists to answer.
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

function buildRow(entitlement, app, counts, roles, owners) {
  const attrs = entitlement.extendedAttributes || {};
  const count = counts.get(entitlement.id);
  const owner = owners.get(entitlement.id);
  const rolesFor = roles.get(entitlement.id) || null;
  const requestable = isRequestable(attrs.requestable);

  return {
    entitlement: entitlement.displayName,
    section: sectionFor({ roles: rolesFor, requestable }),
    requestable: requestable ? 'Yes' : 'No',
    certificationFrequency: certificationFrequency(attrs.certfrequency ?? attrs.certFrequency),
    entitlementOwner: owner?.ownerName ?? null,
    entitlementOwnerEmail: owner?.ownerEmail ?? null,
    businessRoles: rolesFor,
    directAssignments: count?.direct ?? 0,
    viaRoleAssignments: count?.indirect ?? 0,
    ...applicationColumns(app),
    _entity: { kind: 'group', id: entitlement.id },
  };
}

/**
 * The application's own facts, repeated on every one of its rows.
 *
 * Repetition is the point: notices are screen-only, and the CSV is the artefact
 * that gets mailed to an entitlement owner who has no access to this screen. A
 * file that does not say which application it describes is not reviewable.
 *
 * The catalogue field names are deployment-specific, which is why each is read
 * through the spellings that have been seen rather than one guess.
 */
export function applicationColumns(app) {
  const attrs = app?.extendedAttributes || {};
  return {
    application: app?.displayName ?? null,
    applicationDescription: app?.description ?? null,
    applicationOwner: app?.ownerName ?? app?.ownerUserId ?? null,
    abbreviation: pickAttribute(attrs, ['abbreviation']),
    cmdbReference: pickAttribute(attrs, ['cmdbReference', 'cmdbreference']),
    connectionType: pickAttribute(attrs, ['connectionType', 'connectiontype']),
    onboardingSector: pickAttribute(attrs, ['onboardingSector', 'onboardingArea']),
    applicationManager: pickAttribute(attrs, ['applicationManager', 'applicationOwner', 'applicationowner']),
  };
}

// Action list first, then information, then what a role already manages; inside
// a section by application and name, so two runs of the same report compare.
function compareRows(a, b) {
  return SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section)
    || String(a.application ?? '').localeCompare(String(b.application ?? ''))
    || String(a.entitlement ?? '').localeCompare(String(b.entitlement ?? ''));
}

// ─── The summaries ────────────────────────────────────────────────────────

// Five statements about the rows, plus the two the data itself forces: holders
// that are neither direct nor via-role, and frequency values that are the same
// word typed twice.
export function summaries(rows, scope, apps, owners) {
  const total = rows.length;
  const inRole = rows.filter(r => r.section === SECTION_IN_ROLE).length;
  const people = new Set([...owners.values()].flatMap(o => o.ownerIds));
  const frequencies = rows.map(r => r.certificationFrequency);

  const perFrequency = new Map();
  for (const f of frequencies) perFrequency.set(f, (perFrequency.get(f) || 0) + 1);
  const breakdown = [...perFrequency]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, n]) => `${value} ${percentage(n, total)}%`)
    .join(', ');

  const notices = [
    { severity: 'info', text: `${scope.users.toLocaleString('en-US')} unique user(s) hold at least one assignment in ${describe(apps)}.` },
    { severity: 'info', text: `${total.toLocaleString('en-US')} entitlement(s) in scope.` },
    { severity: 'info', text: `${people.size.toLocaleString('en-US')} distinct entitlement owner(s); ${rows.filter(r => !r.entitlementOwner).length.toLocaleString('en-US')} entitlement(s) have no owner.` },
    { severity: 'info', text: `${percentage(inRole, total)}% of entitlements are part of a business role (${inRole.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}).` },
    { severity: 'info', text: `Certification frequency: ${breakdown}.` },
  ];

  const duplicates = nearDuplicateFrequencies(frequencies);
  if (duplicates.length) {
    notices.push({
      severity: 'warning',
      text: `Certification frequency is stored with near-duplicate spellings: ${duplicates.join('; ')}. `
        + 'The values are shown exactly as stored — correct them in the source system, not here.',
    });
  }
  if (scope.eligible > 0) {
    notices.push({
      severity: 'warning',
      text: `${scope.eligible.toLocaleString('en-US')} holder(s) in scope are Eligible rather than Direct or `
        + 'Indirect, so they are in neither count column. That is access someone can activate on demand.',
    });
  }
  return notices;
}
