// The relative-permission policy (Admin → Roles & Permissions → Relative
// permissions): what a person gets because they answer for something, without
// holding an Identity Atlas role. One grid instead of a row of switches:
//
//   subject   what they answer for: a role-bearing context template
//             (lib/contextCategories.js ROLE_BEARING_CATEGORIES — an
//             organisation unit, an application, a role portfolio) or an
//             individual business role (BusinessRoleOwners)
//   role      Accountable or Responsible for it
//   cell      the capabilities that pair gives:
//               view      sign in and see it (read-only; the owner page)
//               subUnits  (contexts) every sub-unit below it, at any depth
//               mcp       (contexts) the same scope through the MCP server
//               review    (business roles) sign off its composition review
//
// A person's scope is the union of the cells that apply to them. Everything is
// off unless a cell says otherwise, and `subUnits` / `mcp` only count where
// `view` is on (normalizePolicy clears them otherwise). `review` stands on its
// own: it also lets someone who signs in with an ordinary role sign off a role
// they answer for.
//
// Pure: storage is auth/contextOwnerSetting.js.

import { ROLE_BEARING_CATEGORIES } from '../lib/contextCategories.js';

export const OWNER_ROLES = Object.freeze(['Accountable', 'Responsible']);
export const BUSINESS_ROLE_SUBJECT = 'BusinessRole';
export const CONTEXT_CAPABILITIES = Object.freeze(['view', 'subUnits', 'mcp']);
export const BUSINESS_ROLE_CAPABILITIES = Object.freeze(['view', 'review']);
// Capabilities that only mean something while `view` is on.
const NEEDS_VIEW = new Set(['subUnits', 'mcp']);

/** The grid's rows: every role-bearing context template, then business roles. */
export function relativeSubjects() {
  return [
    ...[...ROLE_BEARING_CATEGORIES].map(subject => ({ subject, kind: 'context', capabilities: [...CONTEXT_CAPABILITIES] })),
    { subject: BUSINESS_ROLE_SUBJECT, kind: 'businessRole', capabilities: [...BUSINESS_ROLE_CAPABILITIES] },
  ];
}

const capabilitiesOf = (subject) => relativeSubjects().find(s => s.subject === subject)?.capabilities ?? null;

function normalizeCell(cell, capabilities) {
  const out = {};
  for (const cap of capabilities) out[cap] = cell?.[cap] === true;
  if (!out.view) for (const cap of capabilities) if (NEEDS_VIEW.has(cap)) out[cap] = false;
  return out;
}

/**
 * A complete policy for today's subjects from whatever was stored: unknown
 * subjects, roles and capabilities are dropped, anything not literally `true`
 * is off, and view-dependent capabilities are off where `view` is.
 */
export function normalizePolicy(raw) {
  const policy = {};
  for (const { subject, capabilities } of relativeSubjects()) {
    policy[subject] = {};
    for (const role of OWNER_ROLES) policy[subject][role] = normalizeCell(raw?.[subject]?.[role], capabilities);
  }
  return policy;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Check an admin's PUT body: `{ error }` naming the first bad entry, or `{ policy }` (normalized). */
export function validatePolicy(body) {
  if (!isPlainObject(body)) return { error: 'policy must be an object' };
  for (const [subject, roles] of Object.entries(body)) {
    const capabilities = capabilitiesOf(subject);
    if (!capabilities) return { error: `unknown subject ${subject}` };
    if (!isPlainObject(roles)) return { error: `${subject} must be an object` };
    for (const [role, cell] of Object.entries(roles)) {
      if (!OWNER_ROLES.includes(role)) return { error: `unknown role ${role} for ${subject}` };
      if (!isPlainObject(cell)) return { error: `${subject}.${role} must be an object` };
      for (const [cap, value] of Object.entries(cell)) {
        if (!capabilities.includes(cap)) return { error: `unknown capability ${cap} for ${subject}` };
        if (typeof value !== 'boolean') return { error: `${subject}.${role}.${cap} must be a boolean` };
      }
    }
  }
  return { policy: normalizePolicy(body) };
}

/** Does `policy` give a person who is `role` for a `subject` this capability? */
export function allows(policy, subject, role, capability) {
  return policy?.[subject]?.[role]?.[capability] === true;
}

/** The owner roles (Accountable / Responsible) whose `subject` row gives `capability`. */
export function rolesAllowing(policy, subject, capability) {
  return OWNER_ROLES.filter(role => allows(policy, subject, role, capability));
}

/** Does any context row give `capability`? (Is anybody let in through a context?) */
export function anyContextAllows(policy, capability) {
  return [...ROLE_BEARING_CATEGORIES].some(subject => OWNER_ROLES.some(role => allows(policy, subject, role, capability)));
}

/** Does any business-role row give `capability`? */
export function anyBusinessRoleAllows(policy, capability) {
  return OWNER_ROLES.some(role => allows(policy, BUSINESS_ROLE_SUBJECT, role, capability));
}

/** Does the policy let anybody sign in at all? */
export const anyView = (policy) => anyContextAllows(policy, 'view') || anyBusinessRoleAllows(policy, 'view');

/**
 * The policy the four switches it replaced stood for, so an upgrade keeps
 * exactly the access people had: each switch applied to Accountable and
 * Responsible alike, and to every role-bearing template, sub-units included.
 *   access        CONTEXT_OWNER_ACCESS          → contexts view + subUnits
 *   mcp           CONTEXT_OWNER_MCP             → contexts mcp (needed access)
 *   businessRoles CONTEXT_OWNER_BUSINESS_ROLES  → business roles view (needed access)
 *   ownerReview   BUSINESS_ROLE_OWNER_REVIEW    → business roles review (on its own)
 */
export function legacyPolicy({ access = false, mcp = false, businessRoles = false, ownerReview = false } = {}) {
  const raw = {};
  for (const { subject, kind } of relativeSubjects()) {
    const cell = kind === 'context'
      ? { view: access, subUnits: access, mcp: access && mcp }
      : { view: access && businessRoles, review: ownerReview };
    raw[subject] = Object.fromEntries(OWNER_ROLES.map(role => [role, cell]));
  }
  return normalizePolicy(raw);
}
