-- Identity Atlas — Saved report views
--
-- A view is a built-in report with its parameters filled in and a name: "the
-- Ledger access review, with our columns and pivots". It is listed on the
-- Reports page as a report of its own and runs the built-in report with the
-- saved parameters, so it always runs against the current data — nothing is
-- snapshotted except the choices.
--
-- `reportName` is the built-in template's slug (reports/templates/index.js);
-- `params` is the parameter object the template's run() receives, restricted on
-- save to the properties its parametersSchema declares.
--
-- Shared across the deployment, like SavedReports: everyone who can read data can
-- list and run every view; creating, changing and deleting one needs the
-- data.write.reports permission. Names are unique case-insensitively, across all
-- reports, because the Reports page lists them side by side.

CREATE TABLE "ReportViews" (
    "id"          UUID PRIMARY KEY,
    "reportName"  TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "description" TEXT,
    "params"      JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdBy"   TEXT,
    "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedBy"   TEXT,
    "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "ix_ReportViews_name" ON "ReportViews" (LOWER("name"));
