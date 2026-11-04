-- Migration 094: audit log for the MCP server.
--
-- An AI assistant (Claude, ChatGPT, Copilot) reads data on behalf of the
-- signed-in user through /mcp. Every tool call is recorded here: who, from which
-- client, which tool with which arguments, and how it ended — so an admin can see
-- what left the building and on whose behalf. Rows are not stored; only their
-- count.
--
-- Written by mcp/audit.js, read by GET /api/admin/mcp/calls.

CREATE TABLE IF NOT EXISTS "McpToolCalls" (
    "id"          BIGSERIAL PRIMARY KEY,
    "calledAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
    "userOid"     TEXT,
    "userName"    TEXT,
    "client"      TEXT,
    "tool"        TEXT NOT NULL,
    "arguments"   JSONB,
    "outcome"     TEXT NOT NULL,
    "rowCount"    INTEGER,
    "durationMs"  INTEGER,
    "error"       TEXT
);

CREATE INDEX IF NOT EXISTS "ix_McpToolCalls_calledAt" ON "McpToolCalls" ("calledAt" DESC);
