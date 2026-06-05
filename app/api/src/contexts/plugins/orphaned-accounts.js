// orphaned-accounts plugin.
//
// Emits a generated Context tree of Principals that are NOT linked to any
// Identity (no IdentityMembers row), sub-grouped by detected account type
// (Admin / Guest / Service / Shared / Secondary). Orphan-ness is modelled as
// context membership, never a property on the principal.
//
// Runnable standalone (Admin → Contexts) and invoked as the final step of an
// Account Linking run, so the orphans context always reflects what linking
// could not attach. The future principals-clustering plugin refines this set
// into thematic contexts.

import * as db from '../../db/connection.js';
import { classifyAccount } from '../../accountlinking/classifier.js';
import { DEFAULT_RULES } from '../../accountlinking/defaultRules.js';

const ROOT = 'orphaned-accounts';

async function loadRules() {
  try {
    const row = await db.queryOne(
      `SELECT "rules" FROM "AccountLinkingConfig" WHERE "isActive" = true ORDER BY "updatedAt" DESC LIMIT 1`
    );
    return (row && row.rules) ? { ...DEFAULT_RULES, ...row.rules } : DEFAULT_RULES;
  } catch {
    return DEFAULT_RULES;
  }
}

/** @type {import('./types.js').ContextPlugin} */
export default {
  name: 'orphaned-accounts',
  displayName: 'Orphaned Accounts',
  description:
    'Groups Principals that are not linked to any Identity into a context, sub-grouped by detected account ' +
    'type (Admin/Guest/Service/Shared/Secondary). Refreshed automatically by the Account Linking run.',
  targetType: 'Principal',
  parametersSchema: { type: 'object', required: [], properties: {} },

  async run(params, ctx) {
    const rules = await loadRules();

    const orphans = (await db.query(`
      SELECT p."id", p."displayName", p."email", p."extendedAttributes"
        FROM "Principals" p
        LEFT JOIN "IdentityMembers" m ON m."principalId" = p."id"
       WHERE m."principalId" IS NULL
         AND COALESCE(p."principalType", '') NOT IN ('ServicePrincipal', 'ManagedIdentity', 'AIAgent')
    `)).rows;

    const contexts = [{
      externalId: ROOT,
      displayName: 'Orphaned Accounts',
      contextType: 'OrphanedAccounts',
      description: 'Accounts not linked to any identity.',
    }];
    const members = [];
    const seenChild = new Set();

    for (const p of orphans) {
      const { accountType } = classifyAccount(p, rules);
      const childExt = `${ROOT}:${accountType}`;
      if (!seenChild.has(childExt)) {
        seenChild.add(childExt);
        contexts.push({
          externalId: childExt,
          displayName: `Orphaned — ${accountType}`,
          contextType: 'OrphanedAccounts',
          parentExternalId: ROOT,
        });
      }
      members.push({ contextExternalId: childExt, memberId: p.id });
    }

    ctx.log?.(`orphaned-accounts: ${orphans.length} orphan account(s) across ${seenChild.size} type(s)`);
    return { contexts, members };
  },
};
