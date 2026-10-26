// Unit report: the members of an organisational unit, one row each, with how
// many entitlements they hold and everything their source stored about them.
//
// The counterpart of the Entitlement Pivot for a unit of accounts or of people:
// where the pivot asks "who holds what we own", this asks "who is in this team,
// and how much does each of them hold". The first tab of the workbook is the
// same description of each unit the pivot opens with — its attributes, who is
// Accountable and Responsible, or the suggested Accountable and why — from the
// same module (../contextDetails.js). The members' own attributes become
// columns the same way the pivot's entitlement attributes do
// (../attributeColumns.js), capped the same way.
//
// A unit of PEOPLE lists the people; their entitlement count is across every
// account linked to them, which the first tab says. The reads are in
// ../unitMembers.js.
//
// Beside what the source lists, three "Org claim" columns say what the People
// overview says about each person — status, role, and where that came from —
// and the people the sources name whom the list does not list (not confirmed,
// left) follow the members as rows of their own, with what they still hold.
// Those are ../unitClaims.js, built on the overview's own rules.

import * as db from '../../db/connection.js';
import { MAX_LIST, parseList } from '../accessReviewFields.js';
import { MEMBER_ATTRIBUTES, attributeColumns, omittedAttributeNotices } from '../attributeColumns.js';
import { fetchContextDetails, withAfterPeople } from '../contextDetails.js';
import { fetchEntitlementCounts, fetchUnitMembers } from '../unitMembers.js';
import { CLAIM_COLUMNS, claimCells, fetchUnitClaims, summaryEntries } from '../unitClaims.js';
import { READER_STATUSES } from '../../contexts/interviews/claims.js';

// A unit of 120,000 accounts is a whole directory, not a team; the cap says so
// rather than building a file nobody can open.
export const MAX_ROWS = 50000;

// The columns per kind of unit, before the members' attributes. `read` takes
// the member row; the count comes from the grouped read.
const COMMON_LEADING = [
  { key: 'unit', label: 'Unit', read: m => m.unitName },
  { key: 'displayName', label: 'Name', read: m => m.displayName },
  { key: 'status', label: 'Status', read: m => memberStatus(m) },
  { key: 'email', label: 'Email', read: m => m.email },
  { key: 'employeeId', label: 'Employee ID', read: m => m.employeeId },
  { key: 'jobTitle', label: 'Job title', read: m => m.jobTitle },
  { key: 'department', label: 'Department', read: m => m.department },
  { key: 'manager', label: 'Manager', read: m => m.managerName },
];
const KIND_COLUMNS = {
  Principal: [
    { key: 'accountType', label: 'Account type', read: m => m.principalType },
    { key: 'accountEnabled', label: 'Enabled', read: m => m.accountEnabled },
    { key: 'system', label: 'System', read: m => m.systemName },
  ],
  Identity: [
    { key: 'linkedAccounts', label: 'Linked accounts', read: m => m.accountCount },
  ],
};
const ENTITLEMENTS_COLUMN = { key: 'entitlements', label: 'Entitlements' };

export const NOT_LISTED = 'not listed by the source';

/**
 * "current"; "marked former (decision)" when a decision says an interview is
 * right that they left; NOT_LISTED for a person only the added sources name.
 */
export function memberStatus(m) {
  if (m.listed === false) return NOT_LISTED;
  return m.markedFormer ? 'marked former (decision)' : 'current';
}

/** The fixed columns for a kind of unit (Principal or Identity). */
export function baseColumns(kind) {
  return [...COMMON_LEADING, ...(KIND_COLUMNS[kind] || KIND_COLUMNS.Principal)];
}

const columnsOf = fields => fields.map(({ key, label, headerFill }) => (headerFill ? { key, label, headerFill } : { key, label }));

const DECLARED_COLUMNS = columnsOf([...baseColumns('Principal'), ...CLAIM_COLUMNS, ENTITLEMENTS_COLUMN]);

// The claim statuses this run may show: the route's answer for the reader, and
// confirmed only when nobody said (a caller that is not a request).
const claimStatusesOf = ctx => (Array.isArray(ctx?.claimStatuses) ? ctx.claimStatuses : [...READER_STATUSES]);

const COUNT_NOTE = {
  Principal: 'Entitlements counts the distinct resources each account holds (live assignments; business roles '
    + 'are not counted — the entitlements they grant are).',
  Identity: 'Entitlements counts, per person, the distinct resources held across every account linked to them, '
    + 'plus any assigned to the person directly (live assignments; business roles are not counted).',
};

/** The query parameter as a boolean: the form sends "true"/"false", a link may send 1. */
export const isTrue = value => value === true || value === 'true' || value === '1' || value === 1;

export default {
  name: 'unit-members',
  displayName: 'Unit report',
  description: 'The members of one or more organisational units of accounts or people, one row each: their '
    + 'details, how many entitlements each holds, and every attribute their source stored. The Excel '
    + 'download opens with everything known about the unit, including who is accountable for it.',
  form: 'list',
  parametersSchema: {
    type: 'object',
    required: ['contexts'],
    properties: {
      contexts: {
        type: 'array',
        title: 'Units',
        description: 'Organisational units of accounts or of people. A unit of people lists the people, '
          + 'counting entitlements across their linked accounts.',
        'x-lookup': 'unit-contexts',
        'x-lookupPlaceholder': 'Search units…',
        'x-step': 'Scope',
      },
      includeSubUnits: {
        type: 'boolean',
        title: 'Include sub-units',
        description: 'Also list the members of every unit below the ones picked, each under its own unit.',
        default: false,
        'x-step': 'Scope',
      },
    },
  },
  columns: DECLARED_COLUMNS,

  async run(params, ctx) {
    const wanted = parseList(params?.contexts, MAX_LIST);
    if (wanted.length === 0) return { rows: [], notices: [PICK_NOTICE] };
    const units = await resolveUnits(wanted);
    const notices = missingNotices(wanted, units);
    if (units.length === 0) return { rows: [], notices };
    const kinds = new Set(units.map(u => u.targetType));
    if (kinds.size > 1) return { rows: [], notices: [...notices, MIXED_NOTICE] };
    const [kind] = kinds;

    const about = await fetchContextDetails(units);
    notices.push(...about.notices, { severity: 'info', text: COUNT_NOTE[kind] });
    const includeSubUnits = isTrue(params?.includeSubUnits);
    const found = await fetchUnitMembers(kind, units.map(u => u.id), { includeSubUnits, limit: MAX_ROWS + 1 });
    const truncated = found.length > MAX_ROWS;
    const members = truncated ? found.slice(0, MAX_ROWS) : found;

    const statuses = claimStatusesOf(ctx);
    const claims = await fetchUnitClaims(kind, units, members, statuses);
    const result = await memberRows(kind, [...members, ...claims.others], claims.personOf);
    notices.push(...result.notices);
    if (truncated) notices.push(truncationNotice());
    const withProposed = statuses.includes('proposed');
    const details = about.details.map(block => (claims.summaries.has(block.contextId)
      ? withAfterPeople(block, summaryEntries(claims.summaries.get(block.contextId), { withProposed }))
      : block));
    return {
      rows: result.rows, columns: result.columns, notices, truncated, details,
      // One unit and no sub-units: the Unit column holds one value, stated once on the first tab.
      constantColumns: units.length === 1 && !includeSubUnits ? ['unit'] : [],
    };
  },
};

/**
 * The rows, their columns and what is said about them, for members of one kind:
 * the members the source lists, then the people only the added sources name
 * (`listed: false`). `personOf(member)`: the People overview's person for the
 * row (unitClaims.js), or nothing for a run without claims.
 */
export async function memberRows(kind, members, personOf = () => null) {
  const base = baseColumns(kind);
  const fixed = [...base, ...CLAIM_COLUMNS, ENTITLEMENTS_COLUMN];
  const extra = attributeColumns(members, [], fixed.map(c => c.label), { kind: MEMBER_ATTRIBUTES });
  const counts = await fetchEntitlementCounts(kind, [...new Set(members.map(m => m.id).filter(Boolean))]);
  const rows = members.map((member) => {
    const row = {};
    for (const c of base) row[c.key] = blankToNull(c.read(member));
    Object.assign(row, claimCells(personOf(member)));
    // A name no source matched to anyone holds nothing we can count.
    row.entitlements = member.id ? counts.get(member.id) ?? 0 : null;
    for (const f of extra.fields) row[f.key] = f.read({ member });
    if (member.id) row._entity = { kind: kind === 'Identity' ? 'identity' : 'user', id: member.id };
    return row;
  });
  const others = members.filter(m => m.listed === false).length;
  const notices = [
    { severity: 'info', text: `${(rows.length - others).toLocaleString('en-US')} member(s) listed.` },
    ...(others ? [{ severity: 'info', text: othersNotice(others) }] : []),
    ...omittedAttributeNotices(extra.omitted, { kind: MEMBER_ATTRIBUTES }),
  ];
  return { rows, columns: columnsOf([...fixed, ...extra.fields]), notices };
}

const othersNotice = n => `${n.toLocaleString('en-US')} more person(s) follow the members: named by an added `
  + 'source (an interview, a file or notes) but not listed by the source — not confirmed, or left. Their '
  + 'entitlements are counted too: do they still have access?';

const blankToNull = value => (value === undefined || value === '' ? null : value);

// Matched by lower-cased name or by id, like the Entitlement Pivot's contexts.
async function resolveUnits(wanted) {
  const { rows } = await db.query(
    `SELECT c.id, c."displayName", c."targetType"
       FROM "Contexts" c
      WHERE c."targetType" IN ('Principal', 'Identity')
        AND (lower(c."displayName") = ANY($1::text[]) OR c.id::text = ANY($1::text[]))
      ORDER BY c."displayName"`, [wanted.map(w => w.toLowerCase())]);
  return rows;
}

function missingNotices(wanted, units) {
  const found = new Set(units.flatMap(u => [u.displayName.toLowerCase(), u.id.toLowerCase()]));
  const missing = wanted.filter(w => !found.has(w.toLowerCase()));
  if (!missing.length) return [];
  return [{
    severity: 'warning',
    text: `No unit of accounts or people matches ${missing.map(m => `"${m}"`).join(', ')}. `
      + 'Check the spelling against the Contexts page, or pick it from the list.',
  }];
}

const PICK_NOTICE = { severity: 'info', text: 'Pick one or more units of accounts or people.' };

const MIXED_NOTICE = {
  severity: 'warning',
  text: 'Pick units of one kind: units of accounts, or units of people. Their rows and counts mean different '
    + 'things, so one run cannot mix them.',
};

function truncationNotice() {
  return {
    severity: 'warning',
    text: `This run shows the first ${MAX_ROWS.toLocaleString('en-US')} members. Run it per unit to see all of them.`,
  };
}
