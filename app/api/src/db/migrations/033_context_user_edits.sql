-- Analyst curation of generated context trees.
--
-- A generated context tree (e.g. the manager/org tree) is a starting point: the
-- analyst then renames nodes, drags them under a different parent, and adds
-- manual children. We need to (a) remember which generated nodes were touched so
-- the UI can mark them, and (b) NOT throw those edits away the next time the
-- plugin re-runs.
--
-- Two booleans on Contexts capture per-field intent:
--   userRenamed     — displayName was changed by an analyst; the plugin runner
--                     must keep the analyst's name on re-run.
--   userReparented  — parentContextId was changed by an analyst; the runner must
--                     keep the analyst's placement on re-run.
--
-- Manual contexts (variant='manual') are already analyst-owned and visually
-- distinct, so these flags are only meaningful for variant='generated'. They
-- default false and are reset to false whenever the plugin legitimately
-- (re)writes the field for an un-edited node.

ALTER TABLE "Contexts"
  ADD COLUMN IF NOT EXISTS "userRenamed"    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "userReparented" boolean NOT NULL DEFAULT false;
