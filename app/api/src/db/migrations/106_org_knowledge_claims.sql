-- Identity Atlas — Organizational knowledge about people, queryable
-- (docs/architecture/m1-discovery-and-design.md)
--
-- Three new kinds of claim about a PERSON, each naming a canonical object:
--   activity   the person performs a business activity      ("handles claims")
--   expertise  the person has knowledge of a domain          ("motor claims")
--   duty       the person holds a responsibility outside or
--              across their daily work                       ("works council member")
-- (The brief calls the third one holdsResponsibility; it is "duty" here so it is
-- never mistaken for the ContextRole "Responsible".)
--
-- The claim keeps what every claim keeps — the source it comes from, the quote,
-- who proposed it, its status (proposed / confirmed / edited / rejected), who
-- decided it — and objectContextId names the object: a Context of type
-- Activity, Expertise or Duty (template Tag, people as members). A proposed
-- claim may not name one yet; confirming it does (found by name, or created).
--
-- Knowledge only: a claim never creates access and never changes ContextMembers.
-- Additive: no row is changed. Nothing here touches ResourceAssignments.

ALTER TABLE "ContextClaims" DROP CONSTRAINT IF EXISTS "ContextClaims_claimKind_check";
ALTER TABLE "ContextClaims" ADD CONSTRAINT "ContextClaims_claimKind_check"
  CHECK ("claimKind" IN ('description', 'property', 'role', 'roleHistory', 'membership', 'alias', 'activity', 'expertise', 'duty'));

ALTER TABLE "ContextClaims"
  ADD COLUMN IF NOT EXISTS "objectContextId" UUID REFERENCES "Contexts"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "ix_ContextClaims_object" ON "ContextClaims" ("objectContextId") WHERE "objectContextId" IS NOT NULL;
-- The workbench reads every knowledge claim about the people of a unit at once.
CREATE INDEX IF NOT EXISTS "ix_ContextClaims_knowledge_identity" ON "ContextClaims" ("identityId", "claimKind")
  WHERE "claimKind" IN ('activity', 'expertise', 'duty');
CREATE INDEX IF NOT EXISTS "ix_ContextClaims_knowledge_principal" ON "ContextClaims" ("principalId", "claimKind")
  WHERE "claimKind" IN ('activity', 'expertise', 'duty');
