// The MCP audit log (migration 094): one row per tool call — who, from which
// client, which tool with which arguments, and how it ended. Row CONTENT is never
// stored, only how many rows went out.
//
// Recording must never break the answer: a failed insert is logged and dropped.

import { query } from '../db/connection.js';

const MAX_ARGS_CHARS = 4000;
const MAX_TEXT = 300;

export const clip = (value, max = MAX_TEXT) => (value == null ? null : String(value).slice(0, max));

// Arguments as stored: the object itself when it is small, otherwise a marker
// with the start of its JSON — an audit row must stay a row, not a payload.
export function storedArguments(args) {
  if (args == null) return null;
  const json = JSON.stringify(args);
  return json.length <= MAX_ARGS_CHARS ? args : { truncated: true, start: json.slice(0, MAX_ARGS_CHARS) };
}

export async function recordToolCall(entry, q = query) {
  try {
    await q(
      `INSERT INTO "McpToolCalls"
         ("userOid", "userName", "client", "tool", "arguments", "outcome", "rowCount", "durationMs", "error")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        clip(entry.userOid), clip(entry.userName), clip(entry.client), clip(entry.tool),
        JSON.stringify(storedArguments(entry.arguments)), entry.outcome,
        entry.rowCount ?? null, entry.durationMs ?? null, clip(entry.error),
      ],
    );
  } catch (err) {
    console.error('MCP audit write failed:', err.message);
  }
}

export async function listToolCalls({ limit = 50 } = {}, q = query) {
  const n = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 500);
  const { rows } = await q(
    `SELECT "id", "calledAt", "userName", "client", "tool", "arguments", "outcome", "rowCount", "durationMs", "error"
       FROM "McpToolCalls" ORDER BY "calledAt" DESC, "id" DESC LIMIT $1`,
    [n],
  );
  return rows;
}
