-- Auto-update honesty: last-seen version of each running component.
--
-- Web and worker ship from the same image tag and are meant to run the same
-- version, but a partial or interrupted update can leave them out of step. The
-- web version is known live (getCurrentVersion); the worker has no DB access, so
-- it reports its version on its regular job-claim poll (the X-Worker-Version
-- header) and the API upserts it here. Admin → Updates reads this to show the
-- web and worker versions side by side and flag skew when they disagree.
--
-- One row per component. 'web' is derived live and not stored; 'worker' is the
-- one that matters. lastSeenAt lets the UI tell "running an old version" apart
-- from "hasn't checked in" (worker down, or not yet on a build that reports).

CREATE TABLE IF NOT EXISTS "ComponentVersions" (
    "component"  TEXT PRIMARY KEY,                              -- 'worker' (extensible)
    "version"    TEXT,                                          -- reported MODULE_VERSION
    "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
