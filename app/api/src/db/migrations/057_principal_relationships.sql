-- Principal-to-principal relationships: who is responsible for whom.
--
-- Some links are between two *principals*, not a principal and a resource, so
-- they don't fit ResourceAssignments (principal→resource) or ResourceRelationships
-- (resource→resource). The two cases this table exists for:
--
--   * Owner   — the owner(s) of an AI agent / service principal. An AI agent shows
--               up as a Principal (principalType='AIAgent'); its owner is another
--               Principal (a user). Microsoft is standardising owners on Entra
--               Agent ID, so "who is accountable for this agent" is first-class.
--   * Sponsor — the sponsor(s) of a guest (B2B) account. A guest is a Principal
--               (userType='Guest'); its sponsor is another Principal.
--
-- Modelled exactly like the existing single-valued manager link (Principals.managerId)
-- — a principal→principal reference surfaced on the relations tab — but many-to-many
-- (an agent can have several owners; a guest several sponsors), so it needs its own
-- table rather than a column.
--
-- Direction: "principalId" is the SUBJECT that HAS the owner/sponsor (the agent /
-- the guest); "relatedPrincipalId" is the owner / sponsor. relationshipType names
-- the role of relatedPrincipalId with respect to principalId. So:
--   * an agent's owners        = rows WHERE principalId=<agent> AND relationshipType='Owner'
--   * the agents a user owns    = rows WHERE relatedPrincipalId=<user> AND relationshipType='Owner'
--   * a guest's sponsors        = rows WHERE principalId=<guest> AND relationshipType='Sponsor'
--   * the guests a user sponsors= rows WHERE relatedPrincipalId=<user> AND relationshipType='Sponsor'
--
-- No FK on principalId/relatedPrincipalId — same as ResourceRelationships, whose
-- parent/child ids may be ingested in any order and can point at rows from another
-- system. systemId cascades so removing a system clears its links.

CREATE TABLE IF NOT EXISTS "PrincipalRelationships" (
    "principalId"         UUID NOT NULL,
    "relatedPrincipalId"  UUID NOT NULL,
    "relationshipType"    TEXT NOT NULL,
    "systemId"            INTEGER REFERENCES "Systems"("id") ON DELETE CASCADE,
    "externalId"          TEXT,
    "extendedAttributes"  JSONB,
    "createdDateTime"     TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    "modifiedDateTime"    TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    PRIMARY KEY ("principalId", "relatedPrincipalId", "relationshipType"),
    CONSTRAINT "PrincipalRelationships_type_check"
        CHECK ("relationshipType" IN ('Owner', 'Sponsor'))
);

CREATE INDEX IF NOT EXISTS "ix_PR_principal"        ON "PrincipalRelationships"("principalId");
CREATE INDEX IF NOT EXISTS "ix_PR_related"          ON "PrincipalRelationships"("relatedPrincipalId");
CREATE INDEX IF NOT EXISTS "ix_PR_system"           ON "PrincipalRelationships"("systemId");
CREATE INDEX IF NOT EXISTS "ix_PR_related_type"     ON "PrincipalRelationships"("relatedPrincipalId", "relationshipType");
