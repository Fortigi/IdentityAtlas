// Teams bot (POC) — the conversation log.
//
// One row per question (migration 069). This is the POC's evidence: whether the
// bot is usable on CPU-only inference is a question about measured times, and
// "how often is the model unsure?" is a question about counted outcomes. Both
// are unanswerable after the fact if the row was never written, so the write
// path is best-effort and NEVER fails the answer — a logging error is logged and
// swallowed, because losing a measurement is better than losing the reply the
// manager was waiting two minutes for.
//
// The rows of an answer are not stored; see the migration's header for why.

import { randomUUID } from 'crypto';
import { query, queryOne } from '../db/connection.js';
import { forLog } from '../nlreports/assistantHttp.js';

/** How long a conversation row — and therefore its deep link — survives. */
export const DEFAULT_RETENTION_DAYS = 90;

export function retentionDays(env = process.env) {
  const raw = Number(env.TEAMS_BOT_LOG_RETENTION_DAYS);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_RETENTION_DAYS;
}

/**
 * Record one question and what became of it.
 *
 * @param {object} entry
 * @param {string} entry.id               pre-allocated, because the deep link needs it before the row is written
 * @param {string|null} entry.callerOid
 * @param {string|null} entry.callerPrincipalId
 * @param {string|null} entry.conversationId
 * @param {string} entry.question
 * @param {string|null} entry.language
 * @param {object|null} entry.definition  the VALIDATED definition, never the model's raw reply
 * @param {string} entry.outcome          one of the values migration 069 constrains
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
         "id", "callerOid", "callerPrincipalId", "conversationId",
         "question", "language", "definition", "outcome", "clarification",
         "rowCount", "columns", "truncated", "modelMs", "queryMs", "totalMs", "error"
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        entry.id,
        entry.callerOid ?? null,
        entry.callerPrincipalId ?? null,
        entry.conversationId ?? null,
        // The question is the caller's own text and goes in as typed — that is
        // what makes the log an evaluation set. It is capped, and stripped of
        // the control characters that would otherwise let a crafted question
        // forge extra lines in the container log this row is mirrored to.
        forLog(entry.question, 2000),
        entry.language ?? null,
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
    console.error(`teams-bot: conversation log write failed: ${forLog(err.message, 200)}`);
    return null;
  }
}

/** A fresh id for a question that has not been answered yet. */
export const newConversationId = () => randomUUID();

/**
 * The stored definition behind a deep link, for the caller who asked it.
 *
 * Scoped to the asker on purpose. The link is not secret — it is a URL in a chat
 * message that can be forwarded — so the row is only served to the person whose
 * question produced it. Without that, forwarding the card would forward the
 * data, and the POC's one honest claim about exposure ("every answer is logged
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
