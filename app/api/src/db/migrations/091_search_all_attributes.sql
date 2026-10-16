-- Migration 091: search on every attribute, not only the name.
--
-- The list pages searched two or three columns each (a user's name and email, a
-- resource's name and description, a context's name). Everything else a source
-- sends sits in "extendedAttributes" — a CMDB reference on a logical
-- application, an employee number from HR, a mobile phone number from Entra —
-- and none of it could be searched. Finding the person behind a phone number,
-- or the application behind a CMDB id, meant exporting and searching in Excel.
--
-- "Extended search" matches a term against one text per row: its own columns
-- and every value in its extendedAttributes, including values inside lists and
-- nested objects (businessPhones is a list, employeeOrgData an object). That
-- text is not stored. It is the expression of a trigram index, so the table is
-- not rewritten, no ingest path has to maintain anything, and every writer
-- (crawlers, CSV, manual edits, plugins) is covered by construction. Queries
-- use it by repeating the exact expression — lib/entitySearch.js builds it from
-- the same column lists, and entitySearch.migration.test.js fails when the two
-- drift apart.
--
-- Phone numbers and other formatted numbers: "+31 6 1234 5678", "06-12345678"
-- and "0612345678" do not contain each other. A value made only of digits and
-- phone punctuation is therefore also added in digits only ("31612345678"), and
-- the search side strips a numeric term the same way and matches on its last
-- digits (see phoneNeedle in lib/entitySearch.js).
--
-- Changing a column list later means a new migration that drops and recreates
-- the index with the new expression, together with the matching change in
-- lib/entitySearch.js.
--
-- Plain CREATE INDEX (not CONCURRENTLY): the runner wraps each file in a
-- transaction, same as 055. The build blocks writes to the table while it runs.
-- Measured on PGlite: see the PR description.

-- One value, plus its digits-only form when it is a formatted number.
CREATE OR REPLACE FUNCTION public.ia_search_token(val text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
           WHEN val ~ '^[0-9 +()./-]+$' AND val ~ '[0-9]' AND val ~ '[^0-9]'
             THEN val || ' ' || regexp_replace(val, '[^0-9]', '', 'g')
           ELSE val
         END
$$;

-- The searchable text of a row: its columns, then every string or number in
-- its JSON document at any depth. NULL columns and an empty document add
-- nothing.
CREATE OR REPLACE FUNCTION public.ia_search_text(fields text[], doc jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(string_agg(public.ia_search_token(v), ' '), '')
    FROM (
      SELECT f AS v FROM unnest(fields) AS f WHERE f IS NOT NULL AND f <> ''
      UNION ALL
      SELECT item #>> '{}'
        FROM jsonb_path_query(coalesce(doc, '{}'::jsonb), 'strict $.**') AS item
       WHERE jsonb_typeof(item) IN ('string', 'number')
    ) vals
$$;

CREATE INDEX IF NOT EXISTS "ix_Principals_search" ON "Principals" USING GIN (
  public.ia_search_text(ARRAY["id"::text, "displayName", "email", "givenName", "surname", "employeeId", "externalId", "department", "jobTitle", "companyName"], "extendedAttributes")
  gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "ix_Identities_search" ON "Identities" USING GIN (
  public.ia_search_text(ARRAY["id"::text, "displayName", "email", "givenName", "surname", "employeeId", "hrAccountId", "department", "jobTitle", "companyName", "city", "country", "officeLocation"], "extendedAttributes")
  gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "ix_Resources_search" ON "Resources" USING GIN (
  public.ia_search_text(ARRAY["id"::text, "displayName", "description", "mail", "externalId", "resourceType"], "extendedAttributes")
  gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "ix_Contexts_search" ON "Contexts" USING GIN (
  public.ia_search_text(ARRAY["id"::text, "displayName", "description", "externalId", "contextType"], "extendedAttributes")
  gin_trgm_ops);
