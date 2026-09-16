// Missing Managers — who has nobody to certify their access.
//
// Access reviews, joiner-mover-leaver and escalation all route through the
// manager relation, so a missing manager is not a cosmetic gap: it is an
// entitlement nobody can be asked to approve. Both levels of the model can lose
// it independently — the account (`Principals.managerId`) and the person
// (`Identities.managerIdentityId`) — so they share one list with a Type column
// rather than being split into two reports that would always be read together.
//
// Guests are excluded from the account half: an external collaborator has no
// manager in this tenant by design, and listing every one of them would drown
// the finding that matters.

import * as db from '../../db/connection.js';

export default {
  name: 'missing-managers',
  displayName: 'Missing Managers',
  description:
    'Enabled member user accounts with no manager, and identities with no manager identity. '
    + 'Without a manager there is nobody to route an access review or a leaver process to. '
    + 'Guest accounts are excluded — they are not expected to have a manager in this tenant.',
  form: 'list',
  parametersSchema: { type: 'object', required: [], properties: {} },
  columns: [
    { key: 'displayName', label: 'Name' },
    { key: 'rowType', label: 'Type' },
    { key: 'email', label: 'Email' },
    { key: 'department', label: 'Department' },
    { key: 'jobTitle', label: 'Job title' },
  ],

  async run(params, ctx) {
    const [accounts, identities] = await Promise.all([
      db.query(`
        SELECT p.id, p."displayName", p.email, p.department, p."jobTitle"
          FROM "Principals" p
         WHERE p."deletedAt" IS NULL
           AND p."principalType" = 'User'
           AND p."accountEnabled" IS TRUE
           AND p."managerId" IS NULL
           AND COALESCE(p."extendedAttributes"->>'userType', 'Member') <> 'Guest'
         ORDER BY p."displayName"`),
      db.query(`
        SELECT i.id, i."displayName", i.email, i.department, i."jobTitle"
          FROM "Identities" i
         WHERE i."managerIdentityId" IS NULL
         ORDER BY i."displayName"`),
    ]);

    const toRow = (kind, label) => row => ({
      displayName: row.displayName,
      rowType: label,
      email: row.email,
      department: row.department,
      jobTitle: row.jobTitle,
      _entity: { kind, id: row.id },
    });

    const rows = [
      ...accounts.rows.map(toRow('user', 'Account')),
      ...identities.rows.map(toRow('identity', 'Identity')),
    ];

    ctx?.log?.(`missing-managers report: ${accounts.rows.length} account(s), `
      + `${identities.rows.length} identity/identities`);
    return { rows };
  },
};
