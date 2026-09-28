/* =============================================================================
   IdentityIQ-shaped scale fixture — mutation.

   Moves the fixture on the way a real source moves between two refreshes, so an
   incremental load has something to find. A delta that has only ever run against
   unchanged data proves nothing: it cannot tell "read only what changed" from
   "read nothing", and a sweep cannot tell "remove what is gone" from "remove
   nothing".

   Six kinds of change, which between them exercise every path in
   docs/architecture/sql-connector-delta.md:

     1 UPDATED     grants whose `modified` moves forward   -> the watermark finds them
     2 DELETED     grants that disappear                   -> only the key sweep finds them
     3 REINSERTED  grants deleted and put back UNCHANGED,  -> assumption A4: aggregation
                   with their original created/modified       that re-inserts rather than
                                                              updating in place. The row is
                                                              identical, so the delta must
                                                              NOT see it and the sweep must
                                                              NOT remove it.
     4 NEW         an identity, its entitlement grants     -> the identities statement reads
                                                              in full, so completeness finds it
     5 REMOVED     an entitlement and every grant of it    -> the entitlement statement reads
                                                              in full (reconcile); its grants
                                                              need the sweep
     6 TOUCHED     one identity whose `modified` moves     -> assumption A9: does a grant
                   without any of its grants changing         change bump the identity?

   What it does NOT do is guess. Every affected key is written to
   `fixture_mutation` before the change is applied, so a rehearsal compares
   PostgreSQL against the list of rows that actually moved rather than against
   what the crawler says it did.

   Deterministic: rows are chosen by ORDER BY id with OFFSET, so the same fixture
   mutates the same way twice. Re-runnable: each run gets its own batch number and
   picks rows it has not touched before.

   Run with sqlcmd, which substitutes the variables:

     sqlcmd -C -S <host>,<port> -U sa -P <pw> -v DatabaseName=iiq_fixture \
            -v Updated=2000 -v Deleted=500 -v Reinserted=500 -i 03-mutate.sql

   Defaults are set below when a variable is not passed. Volumes are absolute row
   counts, not shares: a sweep's own safety guard refuses to remove more than 5%
   of a scope, and the point of the fixture is to rehearse a NORMAL day.
============================================================================= */
SET NOCOUNT ON;
GO
USE [$(DatabaseName)];
GO

/* ---- What this run will change ----------------------------------------- */
DECLARE @updated    int = TRY_CONVERT(int, N'$(Updated)');
DECLARE @deleted    int = TRY_CONVERT(int, N'$(Deleted)');
DECLARE @reinserted int = TRY_CONVERT(int, N'$(Reinserted)');
SET @updated    = ISNULL(@updated, 2000);
SET @deleted    = ISNULL(@deleted, 500);
SET @reinserted = ISNULL(@reinserted, 500);

/* The clock the source writes: epoch MILLISECONDS, application-written. Every
   timestamp this script sets is "now" in that shape, which is exactly what the
   watermark compares against. */
DECLARE @now numeric(19,0) = CONVERT(numeric(19,0), DATEDIFF_BIG(MILLISECOND, '1970-01-01', SYSUTCDATETIME()));

/* ---- The record of what moved ------------------------------------------ */
IF OBJECT_ID(N'fixture_mutation', N'U') IS NULL
BEGIN
    CREATE TABLE fixture_mutation (
        batch       int            NOT NULL,
        applied_at  numeric(19,0)  NOT NULL,
        change      nvarchar(20)   NOT NULL,   -- updated | deleted | reinserted | new | removed | touched
        table_name  nvarchar(64)   NOT NULL,
        row_id      varchar(32)    NOT NULL,
        identity_id varchar(32)    NULL,
        resource_id varchar(32)    NULL        -- the managed attribute a grant resolves to
    );
    CREATE INDEX ix_fixture_mutation ON fixture_mutation (batch, change);
END;

DECLARE @batch int = (SELECT ISNULL(MAX(batch), 0) + 1 FROM fixture_mutation);
PRINT CONCAT('batch ', @batch, ' at ', @now);

/* A grant and the entitlement id it resolves to. The connector joins on
   application + attribute + value, so the mutation log records the same
   resolution rather than a second, different one. */
IF OBJECT_ID(N'tempdb..#grant') IS NOT NULL DROP TABLE #grant;
SELECT ie.id, ie.identity_id, ma.id AS resource_id
  INTO #grant
  FROM spt_identity_entitlement ie
  JOIN spt_managed_attribute ma
    ON  ma.application = ie.application
    AND ma.attribute   = ie.name
    AND ma.value       = ie.value
 WHERE ie.type = 'Entitlement'
   AND NOT EXISTS (SELECT 1 FROM fixture_mutation m WHERE m.row_id = ie.id);
CREATE INDEX ix_grant ON #grant (id);

/* ---- 1. UPDATED: the watermark must find these -------------------------- */
IF OBJECT_ID(N'tempdb..#upd') IS NOT NULL DROP TABLE #upd;
SELECT TOP (@updated) id, identity_id, resource_id INTO #upd FROM #grant ORDER BY id;

INSERT fixture_mutation (batch, applied_at, change, table_name, row_id, identity_id, resource_id)
SELECT @batch, @now, 'updated', 'spt_identity_entitlement', id, identity_id, resource_id FROM #upd;

UPDATE ie
   SET ie.modified   = @now,
       -- A real change, not only a timestamp: an annotation an analyst edited.
       ie.annotation = CONCAT(N'reviewed in batch ', @batch)
  FROM spt_identity_entitlement ie JOIN #upd u ON u.id = ie.id;

/* ---- 2. DELETED: only a key sweep can find these ------------------------ */
IF OBJECT_ID(N'tempdb..#del') IS NOT NULL DROP TABLE #del;
SELECT TOP (@deleted) g.id, g.identity_id, g.resource_id
  INTO #del
  FROM #grant g WHERE NOT EXISTS (SELECT 1 FROM #upd u WHERE u.id = g.id)
 ORDER BY g.id DESC;

INSERT fixture_mutation (batch, applied_at, change, table_name, row_id, identity_id, resource_id)
SELECT @batch, @now, 'deleted', 'spt_identity_entitlement', id, identity_id, resource_id FROM #del;

DELETE ie FROM spt_identity_entitlement ie JOIN #del d ON d.id = ie.id;

/* ---- 3. REINSERTED unchanged: the A4 shape ------------------------------
   Aggregation that deletes and re-inserts rather than updating in place makes
   every aggregated row look new. These rows come back byte for byte, ORIGINAL
   created and modified included — so a delta that reads them has a watermark
   that is not doing its job, and a sweep that removes them ran during the gap.
   The row id changes, because a re-inserted row is a new row; the KEY the
   connector uses (identity + entitlement) does not.                        */
IF OBJECT_ID(N'tempdb..#re') IS NOT NULL DROP TABLE #re;
SELECT TOP (@reinserted) g.id, g.identity_id, g.resource_id
  INTO #re
  FROM #grant g
 WHERE NOT EXISTS (SELECT 1 FROM #upd u WHERE u.id = g.id)
   AND NOT EXISTS (SELECT 1 FROM #del d WHERE d.id = g.id)
 ORDER BY g.id;

IF OBJECT_ID(N'tempdb..#recopy') IS NOT NULL DROP TABLE #recopy;
SELECT ie.* INTO #recopy FROM spt_identity_entitlement ie JOIN #re r ON r.id = ie.id;

DELETE ie FROM spt_identity_entitlement ie JOIN #re r ON r.id = ie.id;

/* A fresh 32-hex id, the shape Hibernate's UUIDHexGenerator writes. */
INSERT spt_identity_entitlement
SELECT LOWER(CONVERT(varchar(32), CONVERT(binary(16), NEWID()), 2)) AS id,
       created, modified, owner, identity_id, application, native_identity, instance,
       name, value, display_name, annotation, type, aggregation_state, source,
       assigned, allowed, granted_by_role, assigner, assignment_id, start_date, end_date, attributes
  FROM #recopy;

INSERT fixture_mutation (batch, applied_at, change, table_name, row_id, identity_id, resource_id)
SELECT @batch, @now, 'reinserted', 'spt_identity_entitlement', r.id, r.identity_id, r.resource_id FROM #re r;

/* ---- 4. NEW identity, with grants --------------------------------------- */
DECLARE @newIdentity varchar(32) = LOWER(CONVERT(varchar(32), CONVERT(binary(16), NEWID()), 2));
DECLARE @newName nvarchar(128) = CONCAT(N'fixture.newcomer.', @batch);

INSERT spt_identity (id, created, modified, name, display_name, firstname, lastname, email,
                     manager, inactive, workgroup, correlated, type, last_refresh)
SELECT @newIdentity, @now, @now, @newName, CONCAT(N'Fixture Newcomer ', @batch),
       N'Fixture', CONCAT(N'Newcomer ', @batch), CONCAT(@newName, N'@example.invalid'),
       (SELECT TOP (1) id FROM spt_identity WHERE workgroup = 0 OR workgroup IS NULL ORDER BY id),
       0, 0, 1, N'employee', @now;

INSERT fixture_mutation (batch, applied_at, change, table_name, row_id, identity_id, resource_id)
VALUES (@batch, @now, 'new', 'spt_identity', @newIdentity, @newIdentity, NULL);

/* Five entitlements for the newcomer, taken from the ones the fixture already
   has so they resolve through the same join. */
IF OBJECT_ID(N'tempdb..#newgrants') IS NOT NULL DROP TABLE #newgrants;
SELECT TOP (5) ma.id AS resource_id, ma.application, ma.attribute, ma.value,
       LOWER(CONVERT(varchar(32), CONVERT(binary(16), NEWID()), 2)) AS grant_id
  INTO #newgrants
  FROM spt_managed_attribute ma
 WHERE NOT EXISTS (SELECT 1 FROM fixture_mutation m WHERE m.change = 'removed' AND m.row_id = ma.id)
 ORDER BY ma.id;

INSERT spt_identity_entitlement (id, created, modified, identity_id, application, native_identity,
                                 name, value, display_name, type, aggregation_state, source,
                                 assigned, allowed, granted_by_role)
SELECT grant_id, @now, @now, @newIdentity, application, @newName,
       attribute, value, value, N'Entitlement', N'Connected', N'Aggregation', 0, 0, 0
  FROM #newgrants;

INSERT fixture_mutation (batch, applied_at, change, table_name, row_id, identity_id, resource_id)
SELECT @batch, @now, 'new', 'spt_identity_entitlement', grant_id, @newIdentity, resource_id FROM #newgrants;

/* ---- 5. REMOVED entitlement, and every grant of it ---------------------- */
DECLARE @deadEntitlement varchar(32) = (
    SELECT TOP (1) ma.id
      FROM spt_managed_attribute ma
     WHERE NOT EXISTS (SELECT 1 FROM fixture_mutation m WHERE m.row_id = ma.id)
       AND NOT EXISTS (SELECT 1 FROM #newgrants n WHERE n.resource_id = ma.id)
     ORDER BY ma.id DESC);

IF @deadEntitlement IS NOT NULL
BEGIN
    INSERT fixture_mutation (batch, applied_at, change, table_name, row_id, identity_id, resource_id)
    SELECT @batch, @now, 'removed', 'spt_identity_entitlement', ie.id, ie.identity_id, @deadEntitlement
      FROM spt_identity_entitlement ie
      JOIN spt_managed_attribute ma
        ON ma.application = ie.application AND ma.attribute = ie.name AND ma.value = ie.value
     WHERE ma.id = @deadEntitlement;

    DELETE ie
      FROM spt_identity_entitlement ie
      JOIN spt_managed_attribute ma
        ON ma.application = ie.application AND ma.attribute = ie.name AND ma.value = ie.value
     WHERE ma.id = @deadEntitlement;

    INSERT fixture_mutation (batch, applied_at, change, table_name, row_id, identity_id, resource_id)
    VALUES (@batch, @now, 'removed', 'spt_managed_attribute', @deadEntitlement, NULL, @deadEntitlement);

    DELETE FROM spt_managed_attribute WHERE id = @deadEntitlement;
END;

/* ---- 6. TOUCHED identity, no grant of it changed ------------------------
   Assumption A9 asks whether removing a grant bumps the owning identity's
   `modified`. Nothing here can answer that for a real IdentityIQ — only the
   product can — so the fixture makes the two cases distinguishable instead:
   this identity's `modified` moves and none of its grants do, and the
   identities of every deleted grant above are deliberately left alone. A
   narrowed sweep that relies on A9 would therefore MISS those deletions here,
   which is the failure it must be able to demonstrate.                     */
DECLARE @touched varchar(32) = (
    SELECT TOP (1) i.id FROM spt_identity i
     WHERE (i.workgroup = 0 OR i.workgroup IS NULL)
       AND NOT EXISTS (SELECT 1 FROM fixture_mutation m WHERE m.identity_id = i.id)
     ORDER BY i.id DESC);

IF @touched IS NOT NULL
BEGIN
    UPDATE spt_identity SET modified = @now, last_refresh = @now WHERE id = @touched;
    INSERT fixture_mutation (batch, applied_at, change, table_name, row_id, identity_id, resource_id)
    VALUES (@batch, @now, 'touched', 'spt_identity', @touched, @touched, NULL);
END;

/* ---- What a rehearsal should now expect --------------------------------- */
SELECT change, table_name, COUNT(*) AS rows_affected
  FROM fixture_mutation
 WHERE batch = @batch
 GROUP BY change, table_name
 ORDER BY change, table_name;

SELECT @batch AS batch, @now AS applied_at_ms,
       (SELECT COUNT_BIG(*) FROM spt_identity_entitlement WHERE type = 'Entitlement') AS grants_now,
       (SELECT COUNT_BIG(*) FROM spt_managed_attribute) AS entitlements_now,
       (SELECT COUNT_BIG(*) FROM spt_identity) AS identities_now;
GO
