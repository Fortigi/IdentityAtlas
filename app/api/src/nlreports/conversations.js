// The conversation store — every question asked of the report generator, on
// every surface (migrations 069 and 071).
//
// One row per question, threaded by `conversationId`, owned by `callerOid`.
// This is the evidence base for two different questions:
//
//   - Is it usable on this hardware? A question about measured times and
//     counted outcomes, which is what 069 was built for.
//   - Was the answer RIGHT? A question nobody could answer after the fact
//     until 071, because the row held the validated definition and nothing
//     about how the model got there. Now it holds what the model was told and
//     what it replied, so a stronger model can read a whole conversation later
//     and judge it.
//
// Both surfaces write here — the Teams bot and the Ask tab — through the same
// function, so a later evaluation compares like with like.
//
// Writes are best-effort and NEVER fail the answer: a logging error is logged
// and swallowed, because losing a measurement is better than losing the reply
// somebody waited minutes for. Reads are scoped to the caller who asked, always.
//
// The rows of an answer are not stored. Row count and column names only.

import { randomUUID } from 'crypto';
import { query, queryOne } from '../db/connection.js';
import { forLog } from './assistantHttp.js';

/** How long a conversation row — and therefore its deep link — survives. */
export const DEFAULT_RETENTION_DAYS = 90;

// The environment variable keeps the name it shipped with: renaming it would
// silently reset every deployment that set it back to the default.
export function retentionDays(env = process.env) {
  const raw = Number(env.TEAMS_BOT_LOG_RETENTION_DAYS);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_RETENTION_DAYS;
}

/**
 * Every outcome a row may carry — the CHECK constraint in migration 071, as
 * code. Writers use these names rather than typing them, because a misspelt
 * outcome does not fail loudly here: the insert is best-effort, so it would
 * fail QUIETLY and the question would simply never be recorded.
 */
export const OUTCOMES = Object.freeze({
  ANSWERED: 'answered',
  INTERPRETED: 'interpreted',   // web: a definition came back; /run has not filled in the result yet
  CLARIFIED: 'clarified',       // the model asked a question back
  CONFIRM: 'confirm',           // a "did you mean" — the model was unsure of a NAME, not the question
  UNKNOWN_CALLER: 'unknown-caller',
  NOT_UNDERSTOOD: 'not-understood',
  DECLINED: 'declined',         // not about the data, or a request to change something — refused on purpose
  TIMEOUT: 'timeout',
  FAILED: 'failed',
});

export const SURFACES = Object.freeze({ TEAMS: 'teams', WEB: 'web' });

// Prompt text and model output are stored whole enough to review — a values
// block alone can run to thousands of characters — but not without a ceiling.
const MAX_TEXT = 20_000;
const cap = (s, n) => (s === null || s === undefined ? null : String(s).slice(0, n));

/**
 * Record one question and what became of it.
 *
 * @param {object} entry
 * @param {string} entry.id               pre-allocated, because a deep link or a /run may need it before the row is written
 * @param {'teams'|'web'} [entry.surface] which front end asked (default teams, which every pre-071 row is)
 * @param {string|null} entry.callerOid
 * @param {string|null} entry.callerPrincipalId
 * @param {string|null} entry.conversationId
 * @param {string} entry.question
 * @param {string|null} entry.language
 * @param {string|null} [entry.context]   what was put in front of the question for the model
 * @param {string|null} [entry.rawReply]  the model's last reply, verbatim
 * @param {boolean|null} [entry.repaired] whether it took a second attempt
 * @param {string|null} [entry.model]
 * @param {object|null} entry.definition  the VALIDATED definition, never the raw reply
 * @param {string} entry.outcome          one of OUTCOMES
 * @param {string|null} entry.clarification
 * @param {number|null} entry.rowCount
 * @param {string[]|null} entry.columns
 * @param {boolean|null} entry.truncated
 * @param {number|null} entry.modelMs
 * @param {number|null} entry.queryMs
 * @param {number|null} entry.totalMs
 * @param {string|null} entry.error
 * @returns {Promise<string|null>} the row id, or null when the write failed
 */
export async function logConversation(entry, q = query) {
  try {
    await q(
      `INSERT INTO "BotConversations" (
         "id", "surface", "callerOid", "callerPrincipalId", "conversationId",
         "question", "language", "context", "rawReply", "repaired", "model",
         "definition", "outcome", "clarification",
         "rowCount", "columns", "truncated", "modelMs", "queryMs", "totalMs", "error"
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        entry.id,
        entry.surface ?? SURFACES.TEAMS,
        entry.callerOid ?? null,
        entry.callerPrincipalId ?? null,
        entry.conversationId ?? null,
        // The question is the caller's own text and goes in as typed — that is
        // what makes the log an evaluation set. It is capped, and stripped of
        // the control characters that would otherwise let a crafted question
        // forge extra lines in the container log this row is mirrored to.
        forLog(entry.question, 2000),
        entry.language ?? null,
        // Context and reply are NOT mirrored to the container log and are read
        // as prompt text, so their line breaks are kept — a reply flattened to
        // one line is not what the model wrote.
        cap(entry.context, MAX_TEXT),
        cap(entry.rawReply, MAX_TEXT),
        typeof entry.repaired === 'boolean' ? entry.repaired : null,
        entry.model ? forLog(entry.model, 100) : null,
        entry.definition ? JSON.stringify(entry.definition) : null,
        entry.outcome,
        entry.clarification ? forLog(entry.clarification, 500) : null,
        entry.rowCount ?? null,
        entry.columns ?? null,
        entry.truncated ?? null,
        entry.modelMs ?? null,
        entry.queryMs ?? null,
        entry.totalMs ?? null,
        entry.error ? forLog(entry.error, 500) : null,
      ],
    );
    return entry.id;
  } catch (err) {
    console.error(`conversations: log write failed: ${forLog(err.message, 200)}`);
    return null;
  }
}

/** A fresh id for a question that has not been answered yet. */
export const newConversationId = () => randomUUID();

/**
 * Fill in what a definition returned, once the web has run it.
 *
 * The web asks in two requests — /interpret produces the definition, /run
 * executes it — so the row is written at the first and completed here. Three
 * guards decide whether this row is the one being completed, and all three
 * have to hold:
 *
 *   - the caller is the one who asked (auth off: both null, which matches);
 *   - the definition being run is EXACTLY the one that was logged, compared as
 *     jsonb so key order does not matter. The builder lets an analyst edit a
 *     definition and run it again; that run is a different report and must
 *     not be recorded as the answer to the original question;
 *   - the row is still waiting (`interpreted`), so a second run of the same
 *     definition does not overwrite the first result.
 *
 * @returns {Promise<boolean>} whether a row was completed
 */
export async function completeRun({ id, callerOid, definition, rowCount, columns, truncated, queryMs }, q = query) {
  try {
    const { rowCount: updated } = await q(
      `UPDATE "BotConversations"
          SET "outcome" = $4, "rowCount" = $5, "columns" = $6, "truncated" = $7, "queryMs" = $8
        WHERE "id" = $1
          AND "callerOid" IS NOT DISTINCT FROM $2
          AND "definition" = $3::jsonb
          AND "outcome" = $9`,
      [
        id, callerOid ?? null, JSON.stringify(definition),
        OUTCOMES.ANSWERED, rowCount ?? null, columns ?? null, truncated ?? null, queryMs ?? null,
        OUTCOMES.INTERPRETED,
      ],
    );
    return updated === 1;
  } catch (err) {
    console.error(`conversations: completing a run failed: ${forLog(err.message, 200)}`);
    return false;
  }
}

/**
 * The stored definition behind a deep link, for the caller who asked it.
 *
 * Scoped to the asker on purpose. The link is not secret — it is a URL in a chat
 * message that can be forwarded — so the row is only served to the person whose
 * question produced it. Without that, forwarding the card would forward the
 * data, and the one honest claim about exposure ("every answer is logged
 * against the person who asked") would stop being true.
 *
 * @returns {Promise<{id: string, question: string, definition: object} | null>}
 */
export async function findAnswerForCaller(id, callerOid, q = queryOne) {
  const row = await q(
    `SELECT "id", "question", "definition"
       FROM "BotConversations"
      WHERE "id" = $1 AND "callerOid" = $2 AND "definition" IS NOT NULL`,
    [id, callerOid],
  );
  return row ?? null;
}

/**
 * This caller's web conversations, newest first — what a history sidebar lists.
 *
 * Nothing at all for a caller without an id. With authentication off there is
 * no owner to scope to, and the alternative — everyone's questions — is not a
 * history, it is a leak.
 *
 * @returns {Promise<{conversationId: string, startedAt: Date, lastAt: Date, turns: number, firstQuestion: string}[]>}
 */
export async function listConversations(callerOid, { limit = 50 } = {}, q = query) {
  if (!callerOid) return [];
  const { rows } = await q(
    `SELECT "conversationId",
            min("createdAt")                                    AS "startedAt",
            max("createdAt")                                    AS "lastAt",
            count(*)::int                                       AS "turns",
            (array_agg("question" ORDER BY "createdAt"))[1]     AS "firstQuestion"
       FROM "BotConversations"
      WHERE "callerOid" = $1 AND "surface" = $2 AND "conversationId" IS NOT NULL
      GROUP BY "conversationId"
      ORDER BY max("createdAt") DESC
      LIMIT $3`,
    [callerOid, SURFACES.WEB, Math.min(Math.max(1, Number(limit) || 50), 200)],
  );
  return rows ?? [];
}

/**
 * The turns of one conversation, in order, for the caller who had it.
 *
 * `rawReply` is what lets a conversation be RESUMED: it is the assistant turn
 * exactly as the model wrote it, so the history handed back to the model is
 * the one it saw — not a reconstruction from the definition.
 */
export async function getConversation(callerOid, conversationId, q = query) {
  if (!callerOid || !conversationId) return [];
  const { rows } = await q(
    `SELECT "id", "question", "definition", "outcome", "clarification", "rawReply", "rowCount", "createdAt"
       FROM "BotConversations"
      WHERE "callerOid" = $1 AND "conversationId" = $2
      ORDER BY "createdAt" ASC`,
    [callerOid, conversationId],
  );
  return rows ?? [];
}

/**
 * Drop conversations past the retention window.
 *
 * Deletes rather than anonymises: the question text is the personal data here,
 * and a row without it measures nothing that the aggregate counts do not.
 *
 * @returns {Promise<number>} rows removed
 */
export async function sweepExpired(days = retentionDays(), q = query) {
  const { rowCount } = await q(
    `DELETE FROM "BotConversations" WHERE "createdAt" < now() - ($1 || ' days')::interval`,
    [String(days)],
  );
  return rowCount ?? 0;
}
