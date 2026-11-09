-- Migration 092: record what account linking refused to link on a name alone.
--
-- With the shipped rules a single "fullName" match (weight 60) cleared the link
-- threshold (50), so an orphan account could be attached to a person on a
-- display name shared with somebody else. The engine now links such a match only
-- where the name points at exactly one person and holds the rest for review,
-- and a run reports what it held back:
--
--   "nameOnlyMatches"      how many above-threshold matches resting only on name
--                          signals the run held for review instead of linking.
--                          The true, uncapped count.
--   "linksRemoved"         how many previously-scored, analyst-untouched
--                          name-only links the run removed so they re-score
--                          under the current policy.
--   "nameOnlySuggestions"  the held-back matches themselves (account, candidate
--                          identity, confidence, signals, why it was held, which
--                          other identities answer to the name), capped in the
--                          engine so one run cannot store an unbounded document.
--                          "nameOnlyMatches" keeps the true count.
--
-- All three are nullable with no default on purpose: NULL means "this run
-- predates the feature", which must stay distinguishable from a run that looked
-- and found none (0 / []). Adding nullable columns without a default does not
-- rewrite the table.

ALTER TABLE "AccountLinkingRuns" ADD COLUMN IF NOT EXISTS "nameOnlyMatches"     INT;
ALTER TABLE "AccountLinkingRuns" ADD COLUMN IF NOT EXISTS "linksRemoved"        INT;
ALTER TABLE "AccountLinkingRuns" ADD COLUMN IF NOT EXISTS "nameOnlySuggestions" JSONB;
