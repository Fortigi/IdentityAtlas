-- Identity Atlas — a share is a property of a saved matrix (#1202)
--
-- #1166 built shares and saved matrices as two fully decoupled stores: sharing
-- a matrix asked for one name, saving it asked for another, and nothing linked
-- the two. An analyst who shared an unsaved matrix could afterwards neither see
-- that it was shared nor change who it was shared with.
--
-- This migration merges them. A share now points at the `SavedMatrixFilters`
-- row it shares, and that row is the single source of truth for the name and
-- the view-state — which deliberately REVERSES #1166's snapshot decision:
-- recipients see the current saved matrix, not a frozen copy. The snapshot
-- columns stay on the share so the Admin overview can still name a share whose
-- saved matrix was deleted long ago, and so pre-#1202 links keep resolving.
--
-- `tokenHash` becomes nullable: new links address their share by id (the token
-- was never a credential — the sign-in plus the named-recipient gate is what
-- guards a share — and only the hash was ever stored, so "copy the link later"
-- is impossible while the plaintext is the address). Existing `fgs_…` links
-- keep their hash and keep resolving.

ALTER TABLE "MatrixShares"
  ADD COLUMN "savedFilterId" UUID REFERENCES "SavedMatrixFilters" ("id") ON DELETE SET NULL;

-- Deleting a saved matrix must not erase the usage history the "shared but
-- never used" clean-up view exists for, hence SET NULL above rather than
-- CASCADE. The delete route revokes the share in the same transaction, so an
-- orphaned row is always an already-revoked one.

ALTER TABLE "MatrixShares" ALTER COLUMN "tokenHash" DROP NOT NULL;

-- "A share is a property of a saved matrix" — singular. At most one live share
-- per saved matrix, enforced here rather than by UI convention; re-sharing
-- after a revoke inserts a new row, which is what makes "sharing again issues a
-- new link" true by construction.
CREATE UNIQUE INDEX "ix_MatrixShares_activeSavedFilter"
  ON "MatrixShares" ("savedFilterId")
  WHERE "revokedAt" IS NULL AND "savedFilterId" IS NOT NULL;

CREATE INDEX "ix_MatrixShares_savedFilterId" ON "MatrixShares" ("savedFilterId");

-- Backfill: every ACTIVE share becomes a saved matrix, so nothing that is live
-- today is left unmanageable. Revoked shares are deliberately left unlinked —
-- they are history, and materialising a saved matrix for a dead link would
-- pollute the org-wide saved list.
--
-- Re-runnable by design (it only touches active, unlinked shares), which is
-- what lets the contract test drive this exact block against a fixture.
DO $$
DECLARE
  s          RECORD;
  base_name  TEXT;
  candidate  TEXT;
  suffix     INT;
  new_id     UUID;
  new_filter JSONB;
BEGIN
  FOR s IN
    SELECT * FROM "MatrixShares"
     WHERE "revokedAt" IS NULL AND "savedFilterId" IS NULL
     ORDER BY "createdAt"
  LOOP
    -- Saved-matrix names are org-wide unique (ix_SavedMatrixFilters_name, on
    -- LOWER(name)); a share name never was. Suffix rather than overwrite — the
    -- existing saved matrix belongs to somebody else's work.
    base_name := COALESCE(NULLIF(btrim(s."name"), ''), 'Shared matrix');
    candidate := left(base_name, 200);
    suffix    := 1;
    WHILE EXISTS (SELECT 1 FROM "SavedMatrixFilters" f WHERE LOWER(f."name") = LOWER(candidate)) LOOP
      suffix    := suffix + 1;
      candidate := left(base_name, 190) || ' (' || suffix || ')';
    END LOOP;

    -- Fold the two view-state columns back into the filter, the same shape the
    -- wizard saves: orientation carries the display mode, `managed` the
    -- governed toggle. One source of truth instead of three columns the UI
    -- would have to keep in agreement.
    new_filter := s."filter";
    IF s."displayMode" = 'rotated' THEN
      new_filter := new_filter || jsonb_build_object('orientation', 'rows-as-subjects');
    ELSIF s."displayMode" = 'grid' THEN
      new_filter := new_filter - 'orientation';
    END IF;
    IF s."managed" IS NOT NULL THEN
      new_filter := new_filter || jsonb_build_object('managed', s."managed");
    END IF;

    new_id := gen_random_uuid();
    INSERT INTO "SavedMatrixFilters" (id, "name", "description", "filter", "createdBy", "updatedBy")
    VALUES (new_id, candidate, 'Saved from a shared matrix', new_filter, s."createdBy", s."createdBy");

    UPDATE "MatrixShares" SET "savedFilterId" = new_id WHERE id = s.id;
  END LOOP;
END $$;
