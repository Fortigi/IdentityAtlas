/* =============================================================================
   IdentityIQ-shaped scale fixture — schema.

   Recreates the subset of an IdentityIQ (spt_*) schema that an authorization
   export reads, including the kind of site-specific extension columns real
   deployments add to spt_identity and spt_managed_attribute. It holds no real
   data; generate.mjs fills it.

   Run with sqlcmd, which substitutes $(DatabaseName):
     sqlcmd -C -S <host>,<port> -U sa -P <pw> -v DatabaseName=iiq_fixture -i 01-schema.sql

   Conventions copied from IdentityIQ's own SQL Server DDL:
     * ids are varchar(32) lowercase hex (Hibernate UUIDHexGenerator);
     * created / modified / dates are numeric(19,0) epoch MILLISECONDS written
       by the application, not datetimes written by the database;
     * booleans are tinyint;
     * XML attribute maps are nvarchar(max) and CAST to xml by readers.

   Confidence, per column group (tracked until checked against a real
   INFORMATION_SCHEMA dump; see README.md):
     STOCK      standard IdentityIQ column, type from the product DDL
     EXTENSION  deployment-specific column; type is a placeholder (nvarchar(450))
                until the real type is known
   Tables are created as HEAPS, with no keys or indexes: 02-keys.sql adds those
   after the bulk load. IdentityIQ's ids are effectively random, so loading 40M
   rows into a clustered key on id costs a page split per insert; building the
   keys once afterwards is how anyone would load this volume. For an empty
   database, run 01 then 02 back to back.
============================================================================= */
SET NOCOUNT ON;

IF DB_ID(N'$(DatabaseName)') IS NULL
    EXEC(N'CREATE DATABASE [$(DatabaseName)]');
GO
USE [$(DatabaseName)];
GO

-- Re-runnable: drop in dependency order.
DROP TABLE IF EXISTS spt_identity_assigned_roles;
DROP TABLE IF EXISTS spt_bundle_profile_relation;
DROP TABLE IF EXISTS spt_identity_entitlement;
DROP TABLE IF EXISTS spt_managed_attribute;
DROP TABLE IF EXISTS spt_bundle;
DROP TABLE IF EXISTS spt_custom;
DROP TABLE IF EXISTS spt_identity;
DROP TABLE IF EXISTS spt_application;
DROP TABLE IF EXISTS spt_database_version;
GO

CREATE TABLE spt_database_version (
    name            nvarchar(255) NOT NULL,
    system_version  nvarchar(128) NULL,
    schema_version  nvarchar(128) NULL
);

/* ---- spt_application: technical applications (connectors) -------------- */
CREATE TABLE spt_application (
    id              varchar(32)   NOT NULL,      -- STOCK
    created         numeric(19,0) NULL,
    modified        numeric(19,0) NULL,
    owner           varchar(32)   NULL,
    name            nvarchar(128) NOT NULL,
    type            nvarchar(255) NULL,
    connector       nvarchar(255) NULL,
    authoritative   tinyint       NULL,
    attributes      nvarchar(max) NULL
);

/* ---- spt_identity: the person AND the account --------------------------- */
CREATE TABLE spt_identity (
    id                  varchar(32)    NOT NULL, -- STOCK
    created             numeric(19,0)  NULL,
    modified            numeric(19,0)  NULL,
    owner               varchar(32)    NULL,
    name                nvarchar(128)  NOT NULL,             -- STOCK: unique identity name
    display_name        nvarchar(128)  NULL,
    firstname           nvarchar(128)  NULL,
    lastname            nvarchar(128)  NULL,
    email               nvarchar(128)  NULL,
    manager             varchar(32)    NULL,
    inactive            tinyint        NULL,
    workgroup           tinyint        NULL,
    correlated          tinyint        NULL,
    type                nvarchar(128)  NULL,
    last_refresh        numeric(19,0)  NULL,
    attributes          nvarchar(max)  NULL,
    -- EXTENSION columns (placeholder types)
    userid              nvarchar(450)  NULL,
    fullname            nvarchar(450)  NULL,
    jobtitle            nvarchar(450)  NULL,
    companyname         nvarchar(450)  NULL,
    companycode         nvarchar(450)  NULL,
    departmentnumber    nvarchar(450)  NULL,
    costcentercode      nvarchar(450)  NULL,
    employeegroup       nvarchar(450)  NULL,
    employeesubgroup    nvarchar(450)  NULL,
    employeestatus      nvarchar(450)  NULL,
    workcountry         nvarchar(450)  NULL,
    locationid          nvarchar(450)  NULL,
    divcode             nvarchar(450)  NULL,
    divtext             nvarchar(450)  NULL,
    seccode             nvarchar(450)  NULL,
    sectext             nvarchar(450)  NULL,
    subdivcode          nvarchar(450)  NULL,
    subdivtext          nvarchar(450)  NULL,
    hiredate            nvarchar(450)  NULL,
    termination_date    nvarchar(450)  NULL
);

/* ---- spt_managed_attribute: entitlements (and other managed objects) ---- */
CREATE TABLE spt_managed_attribute (
    id                  varchar(32)    NOT NULL, -- STOCK
    created             numeric(19,0)  NULL,
    modified            numeric(19,0)  NULL,
    owner               varchar(32)    NULL,
    application         varchar(32)    NULL,
    type                nvarchar(255)  NULL,                 -- 'Entitlement', 'Permission', …
    attribute           nvarchar(322)  NULL,
    value               nvarchar(450)  NULL,
    hash                nvarchar(128)  NOT NULL,             -- app+attribute+value, unique
    displayable_name    nvarchar(450)  NULL,
    requestable         tinyint        NULL,
    aggregated          tinyint        NULL,
    uncorrelated        tinyint        NULL,
    last_refresh        numeric(19,0)  NULL,
    attributes          nvarchar(max)  NULL,                 -- XML map; carries the logical application name
    -- EXTENSION columns (placeholder types)
    requestdelegateonly nvarchar(450)  NULL,
    certfrequency       nvarchar(450)  NULL,
    costcentercode      nvarchar(450)  NULL,
    gpi_compliance      nvarchar(450)  NULL,
    trainingcheck       nvarchar(450)  NULL,
    ncdetection         nvarchar(450)  NULL,
    usexportcontrol     nvarchar(450)  NULL,
    iiq_elevated_access nvarchar(450)  NULL
);

/* ---- spt_identity_entitlement: who holds what (the 40M-row table) ------- */
CREATE TABLE spt_identity_entitlement (
    id                  varchar(32)    NOT NULL, -- STOCK
    created             numeric(19,0)  NULL,
    modified            numeric(19,0)  NULL,
    owner               varchar(32)    NULL,
    identity_id         varchar(32)    NOT NULL,
    application         varchar(32)    NULL,
    native_identity     nvarchar(322)  NULL,                 -- account on the target system
    instance            nvarchar(128)  NULL,
    name                nvarchar(255)  NULL,                 -- = spt_managed_attribute.attribute
    value               nvarchar(450)  NULL,                 -- = spt_managed_attribute.value
    display_name        nvarchar(255)  NULL,
    annotation          nvarchar(450)  NULL,
    type                nvarchar(255)  NULL,                 -- 'Entitlement' | 'Permission'
    aggregation_state   nvarchar(255)  NULL,
    source              nvarchar(64)   NULL,
    assigned            tinyint        NULL,
    allowed             tinyint        NULL,
    granted_by_role     tinyint        NULL,
    assigner            nvarchar(128)  NULL,
    assignment_id       nvarchar(64)   NULL,
    start_date          numeric(19,0)  NULL,
    end_date            numeric(19,0)  NULL,
    attributes          nvarchar(max)  NULL
);

/* ---- spt_bundle: roles -------------------------------------------------- */
CREATE TABLE spt_bundle (
    id                  varchar(32)    NOT NULL, -- STOCK
    created             numeric(19,0)  NULL,
    modified            numeric(19,0)  NULL,
    owner               varchar(32)    NULL,
    name                nvarchar(128)  NOT NULL,
    display_name        nvarchar(128)  NULL,
    displayable_name    nvarchar(128)  NULL,
    type                nvarchar(128)  NULL,                 -- 'business', 'it', …
    disabled            tinyint        NULL,
    attributes          nvarchar(max)  NULL
);

/* ---- spt_identity_assigned_roles: role assignments ---------------------- */
CREATE TABLE spt_identity_assigned_roles (
    identity_id         varchar(32)    NOT NULL,             -- STOCK
    bundle              varchar(32)    NOT NULL,
    idx                 int            NOT NULL
);

/* ---- spt_bundle_profile_relation: role → entitlement index -------------- */
-- LOW CONFIDENCE beyond bundle_id / source_profile_id / attribute / value /
-- display_value: application_id is what makes an id-based join to
-- spt_managed_attribute possible, and is to be confirmed.
CREATE TABLE spt_bundle_profile_relation (
    id                  varchar(32)    NOT NULL,
    created             numeric(19,0)  NULL,
    modified            numeric(19,0)  NULL,
    bundle_id           varchar(32)    NOT NULL,
    source_bundle_id    varchar(32)    NULL,
    source_profile_id   varchar(32)    NULL,
    application_id      varchar(32)    NULL,
    attribute           nvarchar(322)  NULL,
    value               nvarchar(450)  NULL,
    display_value       nvarchar(450)  NULL,
    type                nvarchar(128)  NULL,
    inherited           tinyint        NULL
);

/* ---- spt_custom: free-form configuration records ------------------------ */
-- One record holds the logical-application catalogue as an XML map keyed by
-- application name. Its name is a generator parameter.
CREATE TABLE spt_custom (
    id                  varchar(32)    NOT NULL, -- STOCK
    created             numeric(19,0)  NULL,
    modified            numeric(19,0)  NULL,
    owner               varchar(32)    NULL,
    name                nvarchar(128)  NULL,
    description         nvarchar(1024) NULL,
    attributes          nvarchar(max)  NULL
);
GO
