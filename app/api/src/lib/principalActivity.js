// Reading the `PrincipalActivity` table — one definition, every consumer.
//
// Activity is collected generically: any crawler that posts to
// `ingest/principal-activity` fills this table, and nothing here knows which
// one did. The list column, the detail endpoint and the activity reports all
// read it through these helpers so "when did this account last sign in" means
// the same thing on every surface.
//
// Two row shapes live in the table (see migration 017): the aggregate
// per-principal row, keyed by a sentinel resourceId, and the per-app row
// (`SignInPerApp`) whose resourceId is the app's service principal.

/** Aggregate (per-principal) activity rows carry this sentinel resourceId. */
export const AGG_RESOURCE_ID = '00000000-0000-0000-0000-000000000000';

/** The activity types that carry a principal's aggregate sign-in timestamps. */
export const AGGREGATE_ACTIVITY_TYPES = ['SignIn', 'ServicePrincipalSignIn'];

/** The per-(principal, app) activity type: "when did X last use app Y?". */
export const PER_APP_ACTIVITY_TYPE = 'SignInPerApp';

const QUOTED_AGGREGATE_TYPES = AGGREGATE_ACTIVITY_TYPES.map(t => `'${t}'`).join(', ');

/**
 * "Has this principal signed in, and when?" — as a SQL expression over an
 * aggregate activity row aliased `alias`.
 *
 * GREATEST over the three core timestamp columns, which in PostgreSQL ignores
 * NULLs and is itself NULL only when all of them are. So an account that only
 * ever signs in non-interactively counts as active: the narrower reading would
 * report a genuinely used account as abandoned.
 *
 * (The risk engine's `resolveLastSignIn` deliberately keeps its own narrower
 * definition — widening it would silently move already-persisted risk scores.)
 */
export function lastSignInExpr(alias = 'pa') {
  return `GREATEST(${alias}."lastSignInDateTime", ${alias}."lastNonInteractiveSignInDateTime",`
    + ` ${alias}."lastSuccessfulSignInDateTime")`;
}

/**
 * A `LEFT JOIN LATERAL` yielding one row per principal — `"lastSignIn"` and
 * `"measuredAt"` — whether or not it has any activity at all (both NULL then,
 * which is "no activity recorded", not "excluded").
 *
 * Aggregated rather than picked with LIMIT 1 because a principal may carry more
 * than one aggregate row (`SignIn` and `ServicePrincipalSignIn` are separate
 * primary keys), and the newest of them is the answer.
 *
 * Binds nothing: both constants are engine values, so callers keep their own
 * `$n` numbering.
 *
 * @param {string} principalAlias  alias of the `Principals` row to correlate to
 * @param {string} outAlias        alias the lateral is exposed under
 */
export function aggregateActivityLateral(principalAlias, outAlias = 'act') {
  return `LEFT JOIN LATERAL (
      SELECT MAX(${lastSignInExpr('pa')}) AS "lastSignIn",
             MAX(pa."updatedAt")          AS "measuredAt"
        FROM "PrincipalActivity" pa
       WHERE pa."principalId" = ${principalAlias}.id
         AND pa."resourceId" = '${AGG_RESOURCE_ID}'::uuid
         AND pa."activityType" IN (${QUOTED_AGGREGATE_TYPES})
    ) ${outAlias} ON TRUE`;
}

/** The aggregate-row predicate on its own, for queries that select the row itself. */
export function aggregateRowWhere(alias = 'pa') {
  return `${alias}."resourceId" = '${AGG_RESOURCE_ID}'::uuid`
    + ` AND ${alias}."activityType" IN (${QUOTED_AGGREGATE_TYPES})`;
}
