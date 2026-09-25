-- Identity Atlas — Teams bot conversation log (POC, feature flag `teamsBot`)
--
-- One row per question asked in a Teams chat. It is the POC's measurement
-- instrument as much as its audit trail: response times are the stated
-- deliverable, and the row count / outcome columns are how "does this feel
-- usable on CPU-only inference?" gets an answer that is not a hunch.
--
-- WHAT IS DELIBERATELY NOT HERE: the answer's rows. They are re-derivable by
-- running `definition` again, and copying them here would duplicate customer
-- data into a log that is kept far longer than any query result needs to be.
-- The same reasoning the report generator already applies to its own audit
-- line (docs/reference/report-generator.md, "Privacy").
--
-- WHAT IS HERE AND IS PERSONAL DATA: `question` is the caller's text, and a
-- question routinely names a colleague ("which groups is Jan de Vries in").
-- `callerOid` identifies the asker. That is the point of an audit trail, but it
-- is why this table has a retention sweep (see TEAMS_BOT_LOG_RETENTION_DAYS)
-- rather than growing forever.
--
-- `definition` doubles as the deep link's payload: the card links to
-- /api/bot-answers/<id>, which re-runs THIS definition rather than saving a
-- report into the shared `SavedReports` list that every analyst sees. So a
-- deleted log row is a dead link — deliberately: the link should not outlive
-- the audit record that explains where it came from.

CREATE TABLE "BotConversations" (
    "id"                UUID PRIMARY KEY,

    -- Who asked, and where. `callerOid` is the Entra object id from the SSO
    -- token; it is also `Principals.id` for an Entra-crawled account, which is
    -- what makes caller resolution a primary-key lookup and not a name match.
    "callerOid"         TEXT,
    "callerPrincipalId" UUID,
    "conversationId"    TEXT,

    -- What was asked. `language` is what the answer was written in ('nl'/'en'),
    -- recorded so a language mismatch can be counted instead of guessed at.
    "question"          TEXT NOT NULL,
    "language"          TEXT,

    -- What the model made of it. `definition` is the VALIDATED report
    -- definition (never the model's raw reply), so anything stored here has
    -- already been through spec.js and is safe to re-run.
    "definition"        JSONB,
    "outcome"           TEXT NOT NULL,
    "clarification"     TEXT,

    -- What came back. Columns are names only — no values.
    "rowCount"          INTEGER,
    "columns"           TEXT[],
    "truncated"         BOOLEAN,

    -- The hardware decision, in three numbers. `modelMs` is the generator,
    -- `queryMs` the SQL, `totalMs` everything the caller waited for including
    -- caller resolution and card rendering.
    "modelMs"           INTEGER,
    "queryMs"           INTEGER,
    "totalMs"           INTEGER,

    "error"             TEXT,
    "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The two ways this table is read: newest-first for "what has the bot been
-- asked", and per-caller for "what has this person seen" — the question an
-- audit actually gets asked, and the one the POC cannot answer with a scope
-- filter because there isn't one yet.
CREATE INDEX "ix_BotConversations_createdAt" ON "BotConversations" ("createdAt" DESC);
CREATE INDEX "ix_BotConversations_caller" ON "BotConversations" ("callerOid", "createdAt" DESC);

-- Outcomes the bot writes. Constrained rather than free text because these are
-- counted, and a typo'd outcome silently becomes a category of its own that
-- nobody notices until the measurements are already wrong.
--   answered      — rows returned (possibly zero)
--   clarified     — one clarifying question asked back
--   unknown-caller— no Principal matched the token's oid
--   not-understood— the model's definition never validated
--   timeout       — the generator did not answer inside the budget
--   failed        — anything else, with `error` set
ALTER TABLE "BotConversations" ADD CONSTRAINT "ck_BotConversations_outcome"
    CHECK ("outcome" IN ('answered', 'clarified', 'unknown-caller', 'not-understood', 'timeout', 'failed'));
