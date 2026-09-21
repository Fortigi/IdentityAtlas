// Teams bot (POC) — who is asking.
//
// The bot must always know who is asking. It resolves the Entra object id from
// the SSO token to the account the Entra crawler already stores, and that is a
// PRIMARY KEY lookup, not a name match: `ConvertTo-EntraPrincipalRecord` writes
// the Graph user's `id` straight into `Principals.id`
// (tools/crawlers/entra-id/EntraIDCrawler.Transform.ps1), and the `oid` claim is
// that same Graph object id. So there is no fuzzy matching here and there must
// never be one — a bot that guesses who you are answers someone else's question.
//
// No match → the caller is not known to Identity Atlas, and the bot stops. There
// is deliberately NO fallback to a default, an anonymous user, or a match on
// email: an account that was never crawled has no business getting answers about
// a directory it is not in.
//
// WHAT THIS DOES NOT DO — and it is the POC's known gap: resolving the caller
// does not restrict what they may ask about. Every caller who gets past this
// function can ask about the whole directory, not just their own people. The
// mitigation is the pilot group plus the conversation log, not this module. See
// `callerScopeFilter` at the bottom for where the filter would slot in.

import { queryOne } from '../db/connection.js';

/**
 * The account behind an Entra object id.
 *
 * @param {string} oid  the `oid` claim from the caller's SSO token
 * @param {(sql: string, params: unknown[]) => Promise<object|null>} [q]  injectable for tests
 * @returns {Promise<{principalId: string, displayName: string|null, email: string|null,
 *                    jobTitle: string|null, department: string|null} | null>}
 */
export async function resolveCaller(oid, q = queryOne) {
  // A malformed oid must not reach the database as a UUID comparison: Postgres
  // raises 22P02 on a bad uuid literal, which would surface as a 500 ("the bot
  // is broken") instead of what it actually is ("this token is not one of ours").
  if (!isUuid(oid)) return null;

  const row = await q(
    `SELECT "id", "displayName", "email", "jobTitle", "department"
       FROM "Principals"
      WHERE "id" = $1
        AND "deletedAt" IS NULL
        AND "principalType" = 'User'`,
    [oid],
  );
  if (!row) return null;

  return {
    principalId: row.id,
    displayName: row.displayName ?? null,
    email: row.email ?? null,
    jobTitle: row.jobTitle ?? null,
    department: row.department ?? null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A string that Postgres will accept as a uuid. */
export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * The caller, as the model is allowed to see them.
 *
 * Deliberately just a name and an id. The report generator's privacy property is
 * that the model never receives rows, values or COUNTS from the data
 * (docs/reference/report-generator.md, "Privacy"), so this does not tell it how
 * many direct reports the caller has or what they own — those are reachable as
 * relations on `@me` without ever being enumerated into the prompt. The caller's
 * own name and account id are the one exception worth making: they are facts the
 * caller already knows about themselves, and without them "my" means nothing.
 *
 * @param {{principalId: string, displayName: string|null}} caller
 * @returns {string} a block prepended to the question, in the model's own idiom
 */
export function callerContextBlock(caller) {
  const name = caller.displayName || 'the person asking';
  return [
    `The person asking this question is ${name}, whose account id is ${caller.principalId}.`,
    'When the request says "my", "mine", "I", "mijn" or "ik", it refers to them.',
    `Write ${ME} as the value whenever a condition should match that person's own account,`,
    `for example "my direct reports" = accounts whose manager relation has id ${ME}.`,
  ].join(' ');
}

/**
 * The sentinel the model writes where the caller's own account belongs.
 *
 * It exists so the caller's identity travels as a REFERENCE that the validator
 * resolves, rather than the bot pasting a uuid into the question and hoping the
 * model copies it back correctly. The validator rejects it outright when there
 * is no caller (spec.js), so the web report builder cannot smuggle one in.
 */
export const ME = '@me';

/**
 * Where the delegate-scope filter goes when the POC becomes a product.
 *
 * Today this returns null and nothing calls it for anything but its comment:
 * v1 is explicitly "the bot knows who is asking; it does not yet restrict what
 * they may see" (pilot group + log are the mitigation). When that changes, this
 * is the seam — it returns the extra condition to AND into every spec the bot
 * runs, so the restriction lands in the compiled SQL rather than in card
 * rendering, and one place decides it for every question.
 *
 * It is a function and not a TODO comment because a filter that is bolted on at
 * the surface later is exactly the client-side patch this repo's coding
 * principles tell you not to write.
 *
 * @returns {null} always, in v1
 */
export function callerScopeFilter(_caller, _spec) {
  return null;
}
