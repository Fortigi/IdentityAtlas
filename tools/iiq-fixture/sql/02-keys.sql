/* =============================================================================
   IdentityIQ-shaped scale fixture — keys and indexes, applied AFTER the load.

     sqlcmd -C -S <host>,<port> -U sa -P <pw> -v DatabaseName=iiq_fixture -i 02-keys.sql

   Primary keys and unique constraints are STOCK IdentityIQ. The secondary
   indexes are PROVISIONAL: they are the ones an export's joins need and that
   the product is known to carry in some form, to be replaced by the real index
   list from the source's sys.indexes. A fixture without them would produce
   query plans that teach nothing.
============================================================================= */
SET NOCOUNT ON;
USE [$(DatabaseName)];
GO

ALTER TABLE spt_database_version        ADD CONSTRAINT pk_spt_database_version        PRIMARY KEY (name);
ALTER TABLE spt_application             ADD CONSTRAINT pk_spt_application             PRIMARY KEY (id);
ALTER TABLE spt_application             ADD CONSTRAINT uq_spt_application_name        UNIQUE (name);
ALTER TABLE spt_identity                ADD CONSTRAINT pk_spt_identity                PRIMARY KEY (id);
ALTER TABLE spt_identity                ADD CONSTRAINT uq_spt_identity_name           UNIQUE (name);
ALTER TABLE spt_managed_attribute       ADD CONSTRAINT pk_spt_managed_attribute       PRIMARY KEY (id);
ALTER TABLE spt_managed_attribute       ADD CONSTRAINT uq_spt_managed_attr_hash       UNIQUE (hash);
ALTER TABLE spt_identity_entitlement    ADD CONSTRAINT pk_spt_identity_entitlement    PRIMARY KEY (id);
ALTER TABLE spt_bundle                  ADD CONSTRAINT pk_spt_bundle                  PRIMARY KEY (id);
ALTER TABLE spt_bundle                  ADD CONSTRAINT uq_spt_bundle_name             UNIQUE (name);
ALTER TABLE spt_identity_assigned_roles ADD CONSTRAINT pk_spt_identity_assigned_roles PRIMARY KEY (identity_id, idx);
ALTER TABLE spt_bundle_profile_relation ADD CONSTRAINT pk_spt_bundle_profile_relation PRIMARY KEY (id);
ALTER TABLE spt_custom                  ADD CONSTRAINT pk_spt_custom                  PRIMARY KEY (id);
GO

-- PROVISIONAL secondary indexes.
CREATE INDEX ix_spt_identity_manager       ON spt_identity (manager);
CREATE INDEX ix_spt_identity_modified      ON spt_identity (modified);
CREATE INDEX ix_spt_managed_attr_app_attr_value ON spt_managed_attribute (application, attribute, value);
CREATE INDEX ix_spt_managed_attr_modified  ON spt_managed_attribute (modified);
CREATE INDEX ix_spt_identity_ent_identity  ON spt_identity_entitlement (identity_id);
CREATE INDEX ix_spt_identity_ent_app_name_value ON spt_identity_entitlement (application, name, value);
CREATE INDEX ix_spt_identity_ent_modified  ON spt_identity_entitlement (modified);
CREATE INDEX ix_spt_bundle_modified        ON spt_bundle (modified);
CREATE INDEX ix_spt_identity_roles_bundle  ON spt_identity_assigned_roles (bundle);
CREATE INDEX ix_spt_bundle_profile_rel_bundle ON spt_bundle_profile_relation (bundle_id);
CREATE INDEX ix_spt_custom_name            ON spt_custom (name);
GO
