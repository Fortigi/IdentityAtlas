// Review campaigns (migration 121): asking the people who answer for a set of
// business roles to do a composition review — which steps, which roles, once or
// on a schedule (lib/reviewCampaignSchedule.js).
//
// A round and its requests are made the first time somebody looks on or after
// the round's first day (ensureRounds): there is no timer, and nothing is sent.
// Who is asked is whoever is Accountable for the role when you look, so nothing
// here stores a person. A round is due at the end of its last day.

import * as db from '../db/connection.js';
import { catalogJoinSql, CATALOG_CATEGORY } from './businessRoleCatalog.js';
import { STEPS } from './compositionReviewSteps.js';
import { INTERVALS, MIN_DUE_DAYS, MAX_DUE_DAYS, parseDay, roundOn, nextRoundOn, dayOf } from './reviewCampaignSchedule.js';

export const MAX_NAME = 200;
export const MAX_SCOPE = 2000;
export const ASKED_ROLE = 'Accountable';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (error) => ({ error });

function idList(value, what) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string' && UUID.test(v))) return fail(`${what} must be a list of ids`);
  return [...new Set(value.map(v => v.toLowerCase()))];
}

/**
 * A new campaign from a request body, or { error }:
 * { name, steps, roleIds, portfolioIds, startsOn, intervalMonths, dueDays }.
 */
export function parseCampaignBody(body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name === '') return fail('Give the campaign a name');
  if (name.length > MAX_NAME) return fail(`The name can be at most ${MAX_NAME} characters`);
  if (!Array.isArray(body.steps) || body.steps.length === 0) return fail('Choose at least one step to review');
  if (!body.steps.every(s => STEPS.includes(s))) return fail(`Unknown step. Use: ${STEPS.join(', ')}`);
  const steps = STEPS.filter(s => body.steps.includes(s));
  const roleIds = idList(body.roleIds, 'The business roles');
  if (roleIds.error) return roleIds;
  const portfolioIds = idList(body.portfolioIds, 'The role portfolios');
  if (portfolioIds.error) return portfolioIds;
  if (roleIds.length + portfolioIds.length === 0) return fail('Choose at least one business role or role portfolio');
  if (roleIds.length + portfolioIds.length > MAX_SCOPE) return fail(`Choose at most ${MAX_SCOPE} roles and portfolios`);
  if (!parseDay(body.startsOn)) return fail('The start date must be a day, as YYYY-MM-DD');
  const intervalMonths = body.intervalMonths ?? null;
  if (intervalMonths !== null && !INTERVALS.includes(intervalMonths)) return fail(`Repeat every ${INTERVALS.join(', ')} months, or not at all`);
  if (!Number.isInteger(body.dueDays) || body.dueDays < MIN_DUE_DAYS || body.dueDays > MAX_DUE_DAYS) {
    return fail(`Give people between ${MIN_DUE_DAYS} and ${MAX_DUE_DAYS} days to review`);
  }
  return { name, steps, roleIds, portfolioIds, startsOn: body.startsOn, intervalMonths, dueDays: body.dueDays };
}

// ─── Rounds ──────────────────────────────────────────────────────────────

// Running campaigns with the number of their newest round (0 = none yet).
export const RUNNING_SQL = `
    SELECT c.id, to_char(c."startsOn", 'YYYY-MM-DD') AS "startsOn", c."intervalMonths", c."dueDays",
           COALESCE((SELECT max(r.number) FROM "ReviewCampaignRounds" r WHERE r."campaignId" = c.id), 0) AS "lastRound"
      FROM "ReviewCampaigns" c
     WHERE c."endedAt" IS NULL AND c."startsOn" <= $1::date`;

export const INSERT_ROUND_SQL = `
    INSERT INTO "ReviewCampaignRounds" ("campaignId", number, "startsAt", "dueAt")
    VALUES ($1, $2, $3::date, $4::date + interval '1 day' - interval '1 second')
    ON CONFLICT ("campaignId", number) DO NOTHING
    RETURNING id`;

// One request per live business role in scope: named by itself, or a member of
// a portfolio in scope as the portfolio is now.
export const INSERT_REQUESTS_SQL = `
    INSERT INTO "ReviewCampaignRequests" ("roundId", "resourceId")
    SELECT $1::uuid, r.id
      FROM "Resources" r
     WHERE r."resourceType" = 'BusinessRole' AND r."deletedAt" IS NULL
       AND (r.id IN (SELECT s."resourceId" FROM "ReviewCampaignScopes" s WHERE s."campaignId" = $2 AND s."resourceId" IS NOT NULL)
         OR r.id IN (SELECT cm."memberId"
                       FROM "ReviewCampaignScopes" s
                       JOIN "ContextMembers" cm ON cm."contextId" = s."contextId" AND cm."memberType" = 'Resource'
                      WHERE s."campaignId" = $2))
    ON CONFLICT ("roundId", "resourceId") DO NOTHING`;

/**
 * Makes the round every running campaign should be in today, with its requests,
 * where it does not exist yet. Safe to call on every read: a second caller's
 * insert conflicts and adds nothing. Returns how many rounds it made.
 */
export async function ensureRounds({ pool = db, tx = db.tx, now = () => new Date() } = {}) {
  const today = dayOf(now());
  const { rows } = await pool.query(RUNNING_SQL, [today]);
  let made = 0;
  for (const campaign of rows) {
    const round = roundOn(campaign, today);
    if (!round || round.number <= Number(campaign.lastRound)) continue;
    made += await tx(async (client) => {
      const inserted = await client.query(INSERT_ROUND_SQL, [campaign.id, round.number, round.startsOn, round.dueOn]);
      if (inserted.rows.length === 0) return 0;
      await client.query(INSERT_REQUESTS_SQL, [inserted.rows[0].id, campaign.id]);
      return 1;
    });
  }
  return made;
}

// ─── What a person is asked ──────────────────────────────────────────────

// The Accountable of a role, through any of the person's accounts: the same
// reach as lib/businessRoleOwners.js OWNED_ROLES_SQL. $1 = principal, $2 = identity.
const ASKED_SQL = `
    EXISTS (SELECT 1 FROM "BusinessRoleOwners" o
             WHERE o."resourceId" = q."resourceId" AND o.role = '${ASKED_ROLE}'
               AND (o."principalId" = $1::uuid
                OR ($2::uuid IS NOT NULL AND (
                      o."identityId" = $2::uuid
                   OR o."principalId" IN (SELECT m."principalId" FROM "IdentityMembers" m WHERE m."identityId" = $2::uuid)))))`;

// A request is open while nobody answered it, its round is the campaign's
// newest and the campaign still runs.
const OPEN_SQL = `
    q."reviewId" IS NULL AND c."endedAt" IS NULL
    AND rd.number = (SELECT max(x.number) FROM "ReviewCampaignRounds" x WHERE x."campaignId" = c.id)`;

// The open requests a person is asked to answer, soonest due first. $3 narrows
// it to one role (NULL = all).
export const MY_REQUESTS_SQL = `
    SELECT q.id, q."resourceId" AS "roleId", r."displayName" AS "roleName",
           pf.id AS "portfolioId", pf."displayName" AS "portfolioName",
           c.id AS "campaignId", c.name AS "campaignName", c.steps,
           rd."dueAt", (rd."dueAt" < now()) AS overdue
      FROM "ReviewCampaignRequests" q
      JOIN "ReviewCampaignRounds" rd ON rd.id = q."roundId"
      JOIN "ReviewCampaigns" c ON c.id = rd."campaignId"
      JOIN "Resources" r ON r.id = q."resourceId" AND r."deletedAt" IS NULL
      ${catalogJoinSql('r.id', 'pf')}
     WHERE ${OPEN_SQL}
       AND ($3::uuid IS NULL OR q."resourceId" = $3::uuid)
       AND ${ASKED_SQL}
     ORDER BY rd."dueAt", r."displayName", q.id`;

/** The open requests for the person behind `me` (auth/resolveMe.js); none for nobody. */
export async function openRequestsFor(me, roleId = null, { pool = db, ensure = ensureRounds } = {}) {
  const principalId = me?.principal?.id;
  if (!principalId) return [];
  await ensure();
  const { rows } = await pool.query(MY_REQUESTS_SQL, [principalId, me.identity?.id ?? null, roleId]);
  return rows;
}

// A review by the asked person answers every open request for that role whose
// campaign asked no step the review left out.
export const ANSWER_REQUESTS_SQL = `
    UPDATE "ReviewCampaignRequests" q
       SET "reviewId" = $4::uuid
      FROM "ReviewCampaignRounds" rd, "ReviewCampaigns" c
     WHERE rd.id = q."roundId" AND c.id = rd."campaignId"
       AND q."resourceId" = $3::uuid
       AND ${OPEN_SQL}
       AND c.steps <@ $5::jsonb
       AND ${ASKED_SQL}
    RETURNING q.id`;

/** Marks the person's open requests for the role as answered by this review. Returns how many. */
export async function answerRequests(me, roleId, review, { pool = db } = {}) {
  const principalId = me?.principal?.id;
  if (!principalId) return 0;
  const steps = JSON.stringify(review.steps.map(s => s.step));
  const { rows } = await pool.query(ANSWER_REQUESTS_SQL, [principalId, me.identity?.id ?? null, roleId, review.id, steps]);
  return rows.length;
}

// ─── Managing campaigns ──────────────────────────────────────────────────

const CAMPAIGN_COLUMNS = `
    c.id, c.name, c."reviewKind", c.steps, c."askedRoles", to_char(c."startsOn", 'YYYY-MM-DD') AS "startsOn",
    c."intervalMonths", c."dueDays", c."endedAt", c."createdBy", c."createdAt"`;

// Each campaign with its newest round and how that round stands. A request
// whose role has nobody Accountable is counted apart: nobody is asked.
export const CAMPAIGNS_SQL = `
    SELECT ${CAMPAIGN_COLUMNS},
           (SELECT count(*)::int FROM "ReviewCampaignScopes" s WHERE s."campaignId" = c.id AND s."resourceId" IS NOT NULL) AS "roleCount",
           (SELECT count(*)::int FROM "ReviewCampaignScopes" s WHERE s."campaignId" = c.id AND s."contextId" IS NOT NULL) AS "portfolioCount",
           rd.number AS "roundNumber", rd."startsAt" AS "roundStartsAt", rd."dueAt" AS "roundDueAt",
           COALESCE(n.total, 0) AS total, COALESCE(n.reviewed, 0) AS reviewed, COALESCE(n.findings, 0) AS findings,
           COALESCE(n."noAccountable", 0) AS "noAccountable", COALESCE(n.waiting, 0) AS waiting
      FROM "ReviewCampaigns" c
      LEFT JOIN LATERAL (SELECT r.* FROM "ReviewCampaignRounds" r WHERE r."campaignId" = c.id ORDER BY r.number DESC LIMIT 1) rd ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS total,
               count(q."reviewId")::int AS reviewed,
               (count(*) FILTER (WHERE q."reviewId" IS NOT NULL AND EXISTS (
                   SELECT 1 FROM "BusinessRoleCompositionReviewSteps" s WHERE s."reviewId" = q."reviewId" AND s.verdict <> 'good')))::int AS findings,
               (count(*) FILTER (WHERE q."reviewId" IS NULL AND NOT EXISTS (
                   SELECT 1 FROM "BusinessRoleOwners" o WHERE o."resourceId" = q."resourceId" AND o.role = '${ASKED_ROLE}')))::int AS "noAccountable",
               (count(*) FILTER (WHERE q."reviewId" IS NULL AND EXISTS (
                   SELECT 1 FROM "BusinessRoleOwners" o WHERE o."resourceId" = q."resourceId" AND o.role = '${ASKED_ROLE}')))::int AS waiting
          FROM "ReviewCampaignRequests" q WHERE q."roundId" = rd.id
      ) n ON true
     WHERE ($1::uuid IS NULL OR c.id = $1::uuid)
     ORDER BY (c."endedAt" IS NOT NULL), c."createdAt" DESC, c.id`;

// The roles of one round: who is asked, and how the request stands.
export const ROUND_REQUESTS_SQL = `
    SELECT q.id, q."resourceId" AS "roleId", r."displayName" AS "roleName", (r."deletedAt" IS NOT NULL) AS "roleDeleted",
           pf."displayName" AS "portfolioName",
           (SELECT string_agg(COALESCE(p."displayName", i."displayName", 'Unnamed'), ', ' ORDER BY COALESCE(p."displayName", i."displayName"))
              FROM "BusinessRoleOwners" o
              LEFT JOIN "Principals" p ON p.id = o."principalId"
              LEFT JOIN "Identities" i ON i.id = o."identityId"
             WHERE o."resourceId" = q."resourceId" AND o.role = '${ASKED_ROLE}') AS accountable,
           q."reviewId", v."reviewedBy", v."reviewedByName", v."reviewedAt",
           (SELECT count(*)::int FROM "BusinessRoleCompositionReviewSteps" s WHERE s."reviewId" = q."reviewId" AND s.verdict <> 'good') AS findings
      FROM "ReviewCampaignRequests" q
      JOIN "Resources" r ON r.id = q."resourceId"
      ${catalogJoinSql('r.id', 'pf')}
      LEFT JOIN "BusinessRoleCompositionReviews" v ON v.id = q."reviewId"
     WHERE q."roundId" = $1
     ORDER BY r."displayName", q.id`;

export const SCOPE_SQL = `
    SELECT s."resourceId", s."contextId", COALESCE(r."displayName", x."displayName") AS "displayName"
      FROM "ReviewCampaignScopes" s
      LEFT JOIN "Resources" r ON r.id = s."resourceId"
      LEFT JOIN "Contexts" x ON x.id = s."contextId"
     WHERE s."campaignId" = $1
     ORDER BY (s."contextId" IS NULL), "displayName"`;

/**
 * How one request stands: reviewed (with or without findings), nobody to ask,
 * late, or waiting. Pure.
 */
export function requestStatus(row, dueAt, now = new Date()) {
  if (row.reviewId) return row.findings > 0 ? 'findings' : 'noFindings';
  if (!row.accountable) return 'noAccountable';
  return new Date(dueAt) < now ? 'overdue' : 'waiting';
}

/** One campaign as the API gives it, with where it stands and when it asks next. Pure. */
export function presentCampaign(row, now = new Date()) {
  const {
    roundNumber, roundStartsAt, roundDueAt, total, reviewed, findings, noAccountable, waiting, ...campaign
  } = row;
  const round = roundNumber == null ? null : {
    number: roundNumber, startsAt: roundStartsAt, dueAt: roundDueAt, overdue: new Date(roundDueAt) < now,
    total, reviewed, findings, noAccountable, waiting,
  };
  const ended = campaign.endedAt != null;
  let nextRoundOnDay = null;
  if (!ended) nextRoundOnDay = round ? nextRoundOn(campaign, round.number) : campaign.startsOn;
  return { ...campaign, status: ended ? 'ended' : (round ? 'running' : 'planned'), round, nextRoundOn: nextRoundOnDay };
}

export async function listCampaigns({ pool = db, ensure = ensureRounds, now = () => new Date() } = {}) {
  await ensure();
  const { rows } = await pool.query(CAMPAIGNS_SQL, [null]);
  return rows.map(r => presentCampaign(r, now()));
}

export const LATEST_ROUND_SQL = `SELECT id, "dueAt" FROM "ReviewCampaignRounds" WHERE "campaignId" = $1 ORDER BY number DESC LIMIT 1`;

/** One campaign with its scope and the roles of its newest round; null when it does not exist. */
export async function loadCampaign(id, { pool = db, ensure = ensureRounds, now = () => new Date() } = {}) {
  await ensure();
  const { rows } = await pool.query(CAMPAIGNS_SQL, [id]);
  if (rows.length === 0) return null;
  const [scope, latest] = await Promise.all([pool.query(SCOPE_SQL, [id]), pool.query(LATEST_ROUND_SQL, [id])]);
  const round = latest.rows[0];
  const requests = round ? (await pool.query(ROUND_REQUESTS_SQL, [round.id])).rows : [];
  const at = now();
  return {
    ...presentCampaign(rows[0], at),
    scope: {
      roles: scope.rows.filter(s => s.resourceId).map(s => ({ id: s.resourceId, displayName: s.displayName })),
      portfolios: scope.rows.filter(s => s.contextId).map(s => ({ id: s.contextId, displayName: s.displayName })),
    },
    requests: requests.map(r => ({ ...r, status: requestStatus(r, round.dueAt, at) })),
  };
}

export const INSERT_CAMPAIGN_SQL = `
    INSERT INTO "ReviewCampaigns" (name, steps, "startsOn", "intervalMonths", "dueDays", "createdBy")
    VALUES ($1, $2::jsonb, $3::date, $4, $5, $6)
    RETURNING id`;

// Only business roles and role portfolios that exist go into the scope; an id
// that is neither is left out, and the count tells the caller.
export const INSERT_ROLE_SCOPE_SQL = `
    INSERT INTO "ReviewCampaignScopes" ("campaignId", "resourceId")
    SELECT $1::uuid, r.id FROM "Resources" r
     WHERE r.id = ANY($2::uuid[]) AND r."resourceType" = 'BusinessRole' AND r."deletedAt" IS NULL`;
export const INSERT_PORTFOLIO_SCOPE_SQL = `
    INSERT INTO "ReviewCampaignScopes" ("campaignId", "contextId")
    SELECT $1::uuid, x.id FROM "Contexts" x
     WHERE x.id = ANY($2::uuid[]) AND x."contextCategory" = '${CATALOG_CATEGORY}'`;

/**
 * Saves a campaign with its scope and, when it starts today or earlier, its
 * first round. Returns { id }, or { error } when nothing in the scope exists.
 */
export async function createCampaign(campaign, by, { tx = db.tx, ensure = ensureRounds } = {}) {
  const made = await tx(async (client) => {
    const { rows } = await client.query(INSERT_CAMPAIGN_SQL, [campaign.name, JSON.stringify(campaign.steps), campaign.startsOn, campaign.intervalMonths, campaign.dueDays, by]);
    const id = rows[0].id;
    const roles = await client.query(INSERT_ROLE_SCOPE_SQL, [id, campaign.roleIds]);
    const portfolios = await client.query(INSERT_PORTFOLIO_SCOPE_SQL, [id, campaign.portfolioIds]);
    if ((roles.rowCount ?? 0) + (portfolios.rowCount ?? 0) === 0) throw Object.assign(new Error('empty scope'), { emptyScope: true });
    return { id };
  }).catch((err) => {
    if (err.emptyScope) return fail('None of the chosen business roles or role portfolios exist any more');
    throw err;
  });
  if (!made.error) await ensure();
  return made;
}

/** Stops a campaign: its open requests close and no round follows. False when it was not running. */
export async function endCampaign(id, { pool = db } = {}) {
  const r = await pool.query(`UPDATE "ReviewCampaigns" SET "endedAt" = now() WHERE id = $1 AND "endedAt" IS NULL`, [id]);
  return r.rowCount > 0;
}

/** Removes a campaign with its rounds and requests. The reviews stay. */
export async function deleteCampaign(id, { pool = db } = {}) {
  const r = await pool.query(`DELETE FROM "ReviewCampaigns" WHERE id = $1`, [id]);
  return r.rowCount > 0;
}

// What a campaign can be about: every live business role with its portfolio and
// whether anybody is Accountable for it, and every role portfolio.
export const SCOPE_ROLES_SQL = `
    SELECT r.id, r."displayName", pf.id AS "portfolioId", pf."displayName" AS "portfolioName",
           EXISTS (SELECT 1 FROM "BusinessRoleOwners" o WHERE o."resourceId" = r.id AND o.role = '${ASKED_ROLE}') AS "hasAccountable"
      FROM "Resources" r
      ${catalogJoinSql('r.id', 'pf')}
     WHERE r."resourceType" = 'BusinessRole' AND r."deletedAt" IS NULL
     ORDER BY r."displayName", r.id`;
export const SCOPE_PORTFOLIOS_SQL = `
    SELECT x.id, x."displayName",
           (SELECT count(*)::int FROM "ContextMembers" cm
              JOIN "Resources" r ON r.id = cm."memberId" AND r."resourceType" = 'BusinessRole' AND r."deletedAt" IS NULL
             WHERE cm."contextId" = x.id AND cm."memberType" = 'Resource') AS "roleCount"
      FROM "Contexts" x
     WHERE x."contextCategory" = '${CATALOG_CATEGORY}'
     ORDER BY x."displayName", x.id`;

export async function scopeOptions({ pool = db } = {}) {
  const [roles, portfolios] = await Promise.all([pool.query(SCOPE_ROLES_SQL), pool.query(SCOPE_PORTFOLIOS_SQL)]);
  return { roles: roles.rows, portfolios: portfolios.rows };
}
