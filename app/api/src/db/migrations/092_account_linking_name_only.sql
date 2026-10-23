-- Migration 092: record what account linking refused to link on a name alone.
--
-- With the shipped rules a single "fullName" match (weight 60) cleared the link
-- threshold (50), so an orphan account could be attached to a person on its
-- display name alone. The engine now holds such a match for review instead of
-- auto-linking it (rules key "allowNameOnlyLinks" restores the old behaviour),
-- and a run reports what it held back:
--
--   "nameOnlyMatches"      how many orphans had an above-threshold best match
--                          resting only on name signals, including the ones the
--                          existing ambiguity (tie) guard already dropped.
--   "linksRemoved"         how many previously-scored, analyst-untouched
--                          name-only links the run removed so they re-score
--                          under the new policy.
--   "nameOnlySuggestions"  the held-back matches themselves (account, candidate
--                          identity, confidence, signals, tie count), capped in
--                          the engine so one run cannot store an unbounded
--                          document. "nameOnlyMatches" keeps the true count.
--
-- All three are nullable with no default on purpose: NULL means "this run
-- predates the feature", which must stay distinguishable from a run that looked
-- and found none (0 / []). Adding nullable columns without a default does not
-- rewrite the table.

ALTER TABLE "AccountLinkingRuns" ADD COLUMN IF NOT EXISTS "nameOnlyMatches"     INT;
ALTER TABLE "AccountLinkingRuns" ADD COLUMN IF NOT EXISTS "linksRemoved"        INT;
ALTER TABLE "AccountLinkingRuns" ADD COLUMN IF NOT EXISTS "nameOnlySuggestions" JSONB;
