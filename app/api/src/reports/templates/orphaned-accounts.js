// Orphaned Accounts — accounts that belong to no identity.
//
// Shares its definition with the orphaned-accounts context plugin via
// accountlinking/orphanQuery.js, so the report and the context can never drift
// apart. Account type comes from the same classifier the linking engine uses.

import { classifyAccount } from '../../accountlinking/classifier.js';
import { fetchOrphanPrincipals, loadActiveLinkingRules } from '../../accountlinking/orphanQuery.js';

/** @type {import('../types.js').ReportTemplate} */
export default {
  name: 'orphaned-accounts',
  displayName: 'Orphaned Accounts',
  description:
    'Accounts that are not linked to any identity, with the account type detected for each. ' +
    'Service principals, managed identities and AI agents are excluded — they are not expected ' +
    'to belong to a person. Note that until account linking has run, no account is linked yet, ' +
    'so every account is listed here.',
  form: 'list',
  parametersSchema: { type: 'object', required: [], properties: {} },
  columns: [
    { key: 'displayName', label: 'Account' },
    { key: 'email', label: 'Email' },
    { key: 'principalType', label: 'Type' },
    { key: 'accountType', label: 'Account type' },
    { key: 'systemName', label: 'System' },
  ],

  async run(params, ctx) {
    const rules = await loadActiveLinkingRules();
    const orphans = await fetchOrphanPrincipals();

    const rows = orphans.map(p => ({
      displayName: p.displayName,
      email: p.email,
      principalType: p.principalType,
      accountType: classifyAccount(p, rules).accountType,
      systemName: p.systemName,
      _entity: { kind: 'user', id: p.id },
    }));

    ctx?.log?.(`orphaned-accounts report: ${rows.length} orphan account(s)`);
    return { rows };
  },
};
