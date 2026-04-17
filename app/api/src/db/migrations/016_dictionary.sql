-- Terminology dictionary for authorization name decoding.
--
-- Three tables:
--   DictionaryTerms         — term + description + business process matches
--   DictionaryCorrelations  — weighted synonym/related-term relationships
--   DictionaryClassifierLinks — proposed classifier pattern additions (pending admin review)
--
-- All LLM-generated proposals land in status='pending' and require admin approval.
-- Correlations are bidirectional but stored as a single directed row; the API
-- returns both directions by querying termId OR relatedTermId.

CREATE TABLE "DictionaryTerms" (
    "id"                BIGSERIAL PRIMARY KEY,
    "term"              TEXT NOT NULL,
    "description"       TEXT,
    "businessProcesses" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "source"            TEXT NOT NULL DEFAULT 'manual',
    "status"            TEXT NOT NULL DEFAULT 'pending',
    "createdBy"         TEXT,
    "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    "updatedAt"         TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    CONSTRAINT "uq_DictionaryTerms_term" UNIQUE ("term"),
    CONSTRAINT "ck_DictionaryTerms_source" CHECK ("source" IN ('manual', 'mined', 'llm')),
    CONSTRAINT "ck_DictionaryTerms_status" CHECK ("status" IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX "ix_DictionaryTerms_status" ON "DictionaryTerms" ("status");
CREATE INDEX "ix_DictionaryTerms_term"   ON "DictionaryTerms" (lower("term"));

-- Correlations between terms (synonym or related).
-- strength: 1.0 = exact synonym, 0.0 = loosely related.
-- Stored once per pair (lower id first) to avoid duplicates; API queries both directions.
CREATE TABLE "DictionaryCorrelations" (
    "id"              BIGSERIAL PRIMARY KEY,
    "termId"          BIGINT NOT NULL REFERENCES "DictionaryTerms"("id") ON DELETE CASCADE,
    "relatedTermId"   BIGINT NOT NULL REFERENCES "DictionaryTerms"("id") ON DELETE CASCADE,
    "strength"        REAL NOT NULL DEFAULT 1.0,
    "correlationType" TEXT NOT NULL DEFAULT 'synonym',
    "source"          TEXT NOT NULL DEFAULT 'manual',
    "status"          TEXT NOT NULL DEFAULT 'pending',
    "createdBy"       TEXT,
    "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    CONSTRAINT "uq_DictionaryCorrelations_pair"   UNIQUE ("termId", "relatedTermId"),
    CONSTRAINT "ck_DictionaryCorrelations_noself" CHECK ("termId" <> "relatedTermId"),
    CONSTRAINT "ck_DictionaryCorrelations_strength" CHECK ("strength" >= 0.0 AND "strength" <= 1.0),
    CONSTRAINT "ck_DictionaryCorrelations_type"   CHECK ("correlationType" IN ('synonym', 'related')),
    CONSTRAINT "ck_DictionaryCorrelations_source" CHECK ("source" IN ('llm', 'manual')),
    CONSTRAINT "ck_DictionaryCorrelations_status" CHECK ("status" IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX "ix_DictionaryCorrelations_termId"        ON "DictionaryCorrelations" ("termId");
CREATE INDEX "ix_DictionaryCorrelations_relatedTermId"  ON "DictionaryCorrelations" ("relatedTermId");
CREATE INDEX "ix_DictionaryCorrelations_status"         ON "DictionaryCorrelations" ("status");

-- LLM-proposed additions to existing classifiers based on dictionary terms.
-- proposedPatterns: array of regex strings to add to the classifier.
-- The admin reviews each link and accepts or rejects the proposed patterns.
CREATE TABLE "DictionaryClassifierLinks" (
    "id"               BIGSERIAL PRIMARY KEY,
    "termId"           BIGINT NOT NULL REFERENCES "DictionaryTerms"("id") ON DELETE CASCADE,
    "classifierLabel"  TEXT NOT NULL,
    "classifierDomain" TEXT,
    "proposedPatterns" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "status"           TEXT NOT NULL DEFAULT 'pending',
    "reviewedBy"       TEXT,
    "reviewedAt"       TIMESTAMPTZ,
    "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    CONSTRAINT "ck_DictionaryClassifierLinks_status" CHECK ("status" IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX "ix_DictionaryClassifierLinks_termId" ON "DictionaryClassifierLinks" ("termId");
CREATE INDEX "ix_DictionaryClassifierLinks_status"  ON "DictionaryClassifierLinks" ("status");
