-- Identity Atlas — Context interviews: membership and alias claims, a relevance
-- tier, and where a quote stands (docs/architecture/context-interviews.md)
--
-- Two new kinds of claim:
--   membership  a person is in the context now, joined, used to be in it, or
--               left it ("X just left the account"). `attribute` carries the
--               status — current, former, joined, left — as it carries a role
--               claim's relation. Knowledge only: confirming one never changes
--               ContextMembers (members come from their source).
--   alias       another name of the context ("also known as X", "or just X").
--               Confirmed, it is added to extendedAttributes.aliases.
-- relevance: how much a claim matters for identity and access governance —
-- 'high' or 'low' (NULL for a claim from before tiers, read as high).
-- quoteStart / quoteEnd: the quote's span in the stored transcript, as string
-- offsets (start inclusive, end exclusive), for the transcript view; NULL when
-- the quote was not found (it is then found when the transcript is opened).
--
-- Additive: no row is changed. Nothing here touches ResourceAssignments.

ALTER TABLE "ContextClaims" DROP CONSTRAINT IF EXISTS "ContextClaims_claimKind_check";
ALTER TABLE "ContextClaims" ADD CONSTRAINT "ContextClaims_claimKind_check"
  CHECK ("claimKind" IN ('description', 'property', 'role', 'roleHistory', 'membership', 'alias'));

ALTER TABLE "ContextClaims"
  ADD COLUMN IF NOT EXISTS "relevance"  TEXT    CHECK ("relevance" IN ('high', 'low')),
  ADD COLUMN IF NOT EXISTS "quoteStart" INTEGER CHECK ("quoteStart" >= 0),
  ADD COLUMN IF NOT EXISTS "quoteEnd"   INTEGER CHECK ("quoteEnd" >= 0);

