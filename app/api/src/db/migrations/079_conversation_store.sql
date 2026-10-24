-- Identity Atlas — every question asked, on every surface, with what the model
-- was told and what it replied.
--
-- WHY. Yesterday's tuning was done blind. A question failed in the chat, and
-- finding out why meant reading the stored definition back out of this table
-- and inferring what the model must have been shown and what it must have
-- written. That worked, twice, and both times it was the slow way to learn
-- something the row could simply have said. The Ask tab wrote nothing at all:
-- refresh the page and the conversation was gone. So quality could not be
-- measured on the web, and could only be inferred in Teams.
--
-- This turns BotConversations into the conversation store for BOTH surfaces:
-- one row per question, threaded by conversationId, owned by callerOid, and
-- now carrying the two things an evaluation actually needs — the per-question
-- context the model was handed, and its raw reply. With those, a stronger model
-- can later read a whole conversation and judge whether the answer was right,
-- which is the only way the prompt gets tuned on evidence instead of anecdote.
--
-- A DELIBERATE REVERSAL. Migration 069 said "the VALIDATED definition, never
-- the model's raw reply". That rule protected against storing something unsafe
-- to re-run, and it still holds for `definition`: rawReply is never executed,
-- it is read. It is the model's own words about the caller's question, so it
-- contains nothing the question and the definition did not already contain.
--
-- WHAT IS STILL NEVER STORED: the rows of an answer. Row COUNT and column NAMES
-- only, as before. The line drawn in 069 is unchanged.
--
-- The table keeps its name. Renaming it would touch every reader for no
-- behavioural gain; the `surface` column says which front end wrote the row.

ALTER TABLE "BotConversations"
    -- Which front end asked. Existing rows are all the Teams bot's.
    ADD COLUMN IF NOT EXISTS "surface"  TEXT NOT NULL DEFAULT 'teams',
    -- Everything put in front of the question for the model on THIS turn: who
    -- is asking, what the previous answer listed, the deployment's values,
    -- name hints, discovered attributes. Not the system prompt — that is
    -- release-stable and reconstructable from the version that wrote the row.
    ADD COLUMN IF NOT EXISTS "context"  TEXT,
    -- The model's last reply, after any repair round. Read, never run.
    ADD COLUMN IF NOT EXISTS "rawReply" TEXT,
    -- Did it take a second attempt. On this hardware that roughly doubles the
    -- wait, so it is the first thing to look at when a question was slow.
    ADD COLUMN IF NOT EXISTS "repaired" BOOLEAN,
    -- Which model answered, so a later comparison knows what it is comparing.
    ADD COLUMN IF NOT EXISTS "model"    TEXT;

ALTER TABLE "BotConversations" DROP CONSTRAINT IF EXISTS "ck_BotConversations_surface";
ALTER TABLE "BotConversations" ADD CONSTRAINT "ck_BotConversations_surface"
    CHECK ("surface" IN ('teams', 'web'));

-- Two outcomes the web path needs that the bot never had. `interpreted`: the
-- model produced a definition and the row is waiting for /run to fill in what
-- it returned (the builder may never run it, and then it stays this way, which
-- is the truth). `confirm`: a "did you mean" went back to the caller — the bot
-- used to file that under `clarified`, which hid the one distinction an
-- evaluation cares about: was the model unsure of the QUESTION or of a NAME.
ALTER TABLE "BotConversations" DROP CONSTRAINT IF EXISTS "ck_BotConversations_outcome";
ALTER TABLE "BotConversations" ADD CONSTRAINT "ck_BotConversations_outcome"
    CHECK ("outcome" IN (
        'answered', 'interpreted', 'clarified', 'confirm',
        'unknown-caller', 'not-understood', 'timeout', 'failed'
    ));

-- "This person's conversations, newest first", and "the turns of one of them
-- in order" — the two reads the history sidebar makes.
CREATE INDEX IF NOT EXISTS "ix_BotConversations_thread"
    ON "BotConversations" ("callerOid", "conversationId", "createdAt");

COMMENT ON TABLE "BotConversations" IS
  'One row per question asked of the report generator, from the Teams bot (surface=teams) or the Ask tab '
  '(surface=web), threaded by conversationId and owned by callerOid. Holds the context the model was '
  'given and its raw reply for later quality review. Never holds an answer''s rows.';
