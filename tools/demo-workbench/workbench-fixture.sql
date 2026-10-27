-- Identity Atlas — Authorization workbench demo fixture (SYNTHETIC — no real people)
--
-- One fictional insurer, "Northwind Insurance (synthetic)", with a Claims Handling
-- unit of 26 people in two teams, what they hold (two systems, one business
-- role), and what a manager interview says they do, know and hold beside their
-- work — confirmed, proposed and disputed — including two works-council members
-- whose works-council access must NOT end up in a claims role.
--
-- Idempotent: it removes what an earlier run of it created, then creates it all
-- again (deterministic ids: md5('wb:<key>')::uuid). It touches nothing else,
-- except that it adds the knowledge roots (Activities, Expertise, Duties) when
-- the database has none. Run inside the postgres container:
--   docker compose -p pocdemo exec -T postgres psql -U identity_atlas -d identity_atlas -v ON_ERROR_STOP=1 < workbench-fixture.sql
-- Design: docs/architecture/m1-discovery-and-design.md.

BEGIN;
SET CONSTRAINTS ALL IMMEDIATE;

-- ─── 0. Remove an earlier run ───────────────────────────────────────────────
DELETE FROM "Contexts" WHERE id = md5('wb:ctx:root')::uuid;                       -- the tree, its members, sources, claims
DELETE FROM "Contexts" WHERE "extendedAttributes"->>'fixture' = 'workbench';      -- the knowledge objects it created
DELETE FROM "Identities" WHERE id IN (SELECT md5('wb:id:' || n)::uuid FROM generate_series(1, 26) n);
DELETE FROM "Systems" WHERE "displayName" IN ('Northwind Directory (synthetic)', 'Northwind ClaimsSuite (synthetic)');

-- ─── 1. The people ──────────────────────────────────────────────────────────
CREATE TEMP TABLE wb_people (n int PRIMARY KEY, name text, title text, team text) ON COMMIT DROP;
INSERT INTO wb_people VALUES
  ( 1, 'Marieke Jansen',     'Head of Claims',              'Claims Handling'),
  ( 2, 'Ruben Hoekstra',     'Fraud specialist',            'Claims Handling'),
  ( 3, 'Yara El Amrani',     'Fraud specialist',            'Claims Handling'),
  ( 4, 'Kees Brouwer',       'Office assistant',            'Claims Handling'),
  ( 5, 'Anna de Vries',      'Team lead Motor',             'Motor Claims'),
  ( 6, 'Tom Bakker',         'Senior claims handler',       'Motor Claims'),
  ( 7, 'Sanne Visser',       'Claims handler',              'Motor Claims'),
  ( 8, 'Daan Mulder',        'Claims handler',              'Motor Claims'),
  ( 9, 'Lotte Smit',         'Claims handler',              'Motor Claims'),
  (10, 'Bram de Graaf',      'Claims handler',              'Motor Claims'),
  (11, 'Fatima Bouzid',      'Claims handler',              'Motor Claims'),
  (12, 'Jeroen Peters',      'Claims handler',              'Motor Claims'),
  (13, 'Noor van Dijk',      'Junior claims handler',       'Motor Claims'),
  (14, 'Pieter Kok',         'Claims handler',              'Motor Claims'),
  (15, 'Eva Meijer',         'Claims handler',              'Motor Claims'),
  (16, 'Luuk Vermeulen',     'Claims handler',              'Motor Claims'),
  (17, 'Sophie Willems',     'Team lead Property',          'Property Claims'),
  (18, 'Thijs Dekker',       'Senior claims handler',       'Property Claims'),
  (19, 'Iris Hendriks',      'Loss adjuster',               'Property Claims'),
  (20, 'Mohamed Aydin',      'Loss adjuster',               'Property Claims'),
  (21, 'Julia Bos',          'Claims handler',              'Property Claims'),
  (22, 'Stijn Koster',       'Claims handler',              'Property Claims'),
  (23, 'Femke Prins',        'Claims handler',              'Property Claims'),
  (24, 'Hugo Schouten',      'Claims handler',              'Property Claims'),
  (25, 'Lisa Vos',           'Claims lawyer',               'Property Claims'),
  (26, 'Max Jacobs',         'Claims lawyer',               'Property Claims');

-- ─── 2. Systems, accounts, identities ───────────────────────────────────────
INSERT INTO "Systems" ("systemType", "displayName", description)
VALUES ('test', 'Northwind Directory (synthetic)', 'Workbench demo fixture — fictional directory'),
       ('test', 'Northwind ClaimsSuite (synthetic)', 'Workbench demo fixture — fictional claims application');

INSERT INTO "Identities" (id, "displayName", email, "jobTitle", department)
SELECT md5('wb:id:' || n)::uuid, name, lower(replace(name, ' ', '.')) || '@northwind.example', title, team FROM wb_people;

INSERT INTO "Principals" (id, "systemId", "displayName", email, "principalType", "accountEnabled", "jobTitle", department, "extendedAttributes")
SELECT md5('wb:p:' || n)::uuid, (SELECT id FROM "Systems" WHERE "displayName" = 'Northwind Directory (synthetic)'),
       name, lower(replace(name, ' ', '.')) || '@northwind.example', 'User', true, title, team, '{"fixture":"workbench"}'::jsonb
  FROM wb_people;
-- Anna has a second, administrative account: one person, two accounts.
INSERT INTO "Principals" (id, "systemId", "displayName", email, "principalType", "accountEnabled", "extendedAttributes")
VALUES (md5('wb:p:5-adm')::uuid, (SELECT id FROM "Systems" WHERE "displayName" = 'Northwind Directory (synthetic)'),
        'adm-anna.devries', NULL, 'User', true, '{"fixture":"workbench"}'::jsonb);

INSERT INTO "IdentityMembers" ("identityId", "principalId", "isPrimary", "accountType", "displayName")
SELECT md5('wb:id:' || n)::uuid, md5('wb:p:' || n)::uuid, true, 'Regular', name FROM wb_people
UNION ALL
SELECT md5('wb:id:5')::uuid, md5('wb:p:5-adm')::uuid, false, 'Admin', 'adm-anna.devries';

-- ─── 3. What they hold ──────────────────────────────────────────────────────
CREATE TEMP TABLE wb_res (key text PRIMARY KEY, name text, sys text, rtype text) ON COMMIT DROP;
INSERT INTO wb_res VALUES
  ('all',       'SG-Claims-All',                 'dir', 'Group'),
  ('print',     'SG-Print-Claims',               'dir', 'Group'),
  ('read',      'ClaimsSuite — Read',            'cs',  'AppRole'),
  ('motor',     'ClaimsSuite — Motor handler',   'cs',  'AppRole'),
  ('property',  'ClaimsSuite — Property handler','cs',  'AppRole'),
  ('approve',   'ClaimsSuite — Approve > €25k',  'cs',  'AppRole'),
  ('fraud',     'ClaimsSuite — Fraud workbench', 'cs',  'AppRole'),
  ('keyuser',   'ClaimsSuite — Configuration',   'cs',  'AppRole'),
  ('garage',    'GarageNet portal',              'dir', 'Group'),
  ('survey',    'Survey app (loss adjusting)',   'dir', 'Group'),
  ('legal',     'Subrogation database',          'dir', 'Group'),
  ('or-site',   'SP-WorksCouncil-Site',          'dir', 'Group'),
  ('or-mail',   'Mail-WorksCouncil',             'dir', 'Group'),
  ('bhv',       'BHV roster',                    'dir', 'Group'),
  ('migration', 'Teams — ClaimsSuite migration', 'dir', 'Group'),
  ('payments',  'Finance — Payments approve',    'dir', 'Group'),
  ('hrportal',  'HR portal — Admin',             'dir', 'Group');

INSERT INTO "Resources" (id, "systemId", "displayName", "resourceType", enabled, "extendedAttributes")
SELECT md5('wb:r:' || key)::uuid,
       (SELECT id FROM "Systems" WHERE "displayName" = CASE sys WHEN 'cs' THEN 'Northwind ClaimsSuite (synthetic)' ELSE 'Northwind Directory (synthetic)' END),
       name, rtype, true, '{"fixture":"workbench"}'::jsonb
  FROM wb_res;
-- The existing business role "Claims handler — Motor": Read + Motor handler + SG-Claims-All.
INSERT INTO "Resources" (id, "systemId", "displayName", "resourceType", enabled, "governanceResource", description, "extendedAttributes")
VALUES (md5('wb:r:br-motor')::uuid, (SELECT id FROM "Systems" WHERE "displayName" = 'Northwind ClaimsSuite (synthetic)'),
        'Claims handler — Motor', 'BusinessRole', true, true, 'Existing business role (synthetic)', '{"fixture":"workbench"}'::jsonb);
INSERT INTO "ResourceRelationships" ("parentResourceId", "childResourceId", "relationshipType", "systemId")
SELECT md5('wb:r:br-motor')::uuid, md5('wb:r:' || k)::uuid, 'Contains', (SELECT id FROM "Systems" WHERE "displayName" = 'Northwind ClaimsSuite (synthetic)')
  FROM unnest(ARRAY['read', 'motor', 'all']) k;

-- (person, resource, type). Indirect: through a nested group in the source.
CREATE TEMP TABLE wb_grants (n int, key text, t text) ON COMMIT DROP;
INSERT INTO wb_grants
SELECT n, 'all', CASE WHEN n <= 4 THEN 'Direct' ELSE 'Indirect' END FROM wb_people
UNION ALL SELECT n, 'read', 'Direct' FROM wb_people WHERE n <> 4
UNION ALL SELECT n, 'print', 'Indirect' FROM wb_people WHERE n NOT IN (2, 3, 25, 26)
UNION ALL SELECT n, 'motor', 'Direct' FROM generate_series(5, 16) n
UNION ALL SELECT n, 'property', 'Direct' FROM generate_series(17, 24) n
UNION ALL SELECT n, 'approve', 'Direct' FROM unnest(ARRAY[1, 5, 6, 17, 18]) n
UNION ALL SELECT n, 'fraud', 'Direct' FROM unnest(ARRAY[2, 3, 6]) n
UNION ALL SELECT n, 'keyuser', 'Direct' FROM unnest(ARRAY[7, 21]) n
UNION ALL SELECT n, 'garage', 'Direct' FROM unnest(ARRAY[8, 9, 14]) n
UNION ALL SELECT n, 'survey', 'Direct' FROM unnest(ARRAY[19, 20, 18]) n
UNION ALL SELECT n, 'legal', 'Direct' FROM unnest(ARRAY[25, 26]) n
UNION ALL SELECT n, 'or-site', 'Direct' FROM unnest(ARRAY[10, 22]) n
UNION ALL SELECT n, 'or-mail', 'Direct' FROM unnest(ARRAY[10, 22]) n
UNION ALL SELECT 15, 'bhv', 'Direct'
UNION ALL SELECT 12, 'migration', 'Direct'
UNION ALL SELECT 11, 'payments', 'Direct'          -- left over from a previous job: unexplained
UNION ALL SELECT 4, 'hrportal', 'Eligible';        -- eligible only: needs investigation

INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "systemId", "principalType")
SELECT md5('wb:r:' || g.key)::uuid, md5('wb:p:' || g.n)::uuid, g.t, r."systemId", 'User'
  FROM wb_grants g JOIN "Resources" r ON r.id = md5('wb:r:' || g.key)::uuid;
-- Anna's admin account holds the configuration role (the same person, another account).
INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "systemId", "principalType")
VALUES (md5('wb:r:keyuser')::uuid, md5('wb:p:5-adm')::uuid, 'Direct',
        (SELECT id FROM "Systems" WHERE "displayName" = 'Northwind ClaimsSuite (synthetic)'), 'User');
-- The business role is held by 8 of the 12 motor people (governed).
INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "systemId", "principalType", governed)
SELECT md5('wb:r:br-motor')::uuid, md5('wb:p:' || n)::uuid, 'Direct',
       (SELECT id FROM "Systems" WHERE "displayName" = 'Northwind ClaimsSuite (synthetic)'), 'User', true
  FROM unnest(ARRAY[5, 6, 7, 8, 9, 10, 11, 13]) n;

-- ─── 4. The unit tree and its members ───────────────────────────────────────
INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "contextCategory", "displayName", description, "parentContextId", "createdByUser", "extendedAttributes")
VALUES
  (md5('wb:ctx:root')::uuid, 'manual', 'Identity', 'Department', 'OrganizationalUnit', 'Northwind Insurance (synthetic)',
   'A fictional insurer for the Authorization workbench demo. No real people.', NULL, 'workbench-fixture', '{"fixture":"workbench"}'),
  (md5('wb:ctx:claims')::uuid, 'manual', 'Identity', 'Department', 'OrganizationalUnit', 'Claims Handling',
   'Handles motor and property claims, from first notice to payment.', md5('wb:ctx:root')::uuid, 'workbench-fixture', '{"fixture":"workbench"}'),
  (md5('wb:ctx:motor')::uuid, 'manual', 'Identity', 'Team', 'OrganizationalUnit', 'Motor Claims',
   NULL, md5('wb:ctx:claims')::uuid, 'workbench-fixture', '{"fixture":"workbench"}'),
  (md5('wb:ctx:property')::uuid, 'manual', 'Identity', 'Team', 'OrganizationalUnit', 'Property Claims',
   NULL, md5('wb:ctx:claims')::uuid, 'workbench-fixture', '{"fixture":"workbench"}');

INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy")
SELECT CASE team WHEN 'Motor Claims' THEN md5('wb:ctx:motor')::uuid WHEN 'Property Claims' THEN md5('wb:ctx:property')::uuid
                 ELSE md5('wb:ctx:claims')::uuid END,
       'Identity', md5('wb:id:' || n)::uuid, 'analyst'
  FROM wb_people;

INSERT INTO "ContextRoles" ("contextId", "identityId", role, "addedBy")
VALUES (md5('wb:ctx:claims')::uuid, md5('wb:id:1')::uuid, 'Accountable', 'analyst'),
       (md5('wb:ctx:motor')::uuid, md5('wb:id:5')::uuid, 'Accountable', 'analyst'),
       (md5('wb:ctx:property')::uuid, md5('wb:id:17')::uuid, 'Accountable', 'analyst');

-- ─── 5. The sources: a manager interview and an older team list ─────────────
INSERT INTO "ContextInterviews" (id, "contextId", "identityId", "intervieweeName", "interviewedAt", "fileName", transcript, "extractionStatus", "createdBy")
VALUES (md5('wb:iv:marieke')::uuid, md5('wb:ctx:claims')::uuid, md5('wb:id:1')::uuid, 'Marieke Jansen', DATE '2026-10-20',
  'interview-marieke-jansen.txt',
$t$Interviewer: Can you walk me through who does what in Claims Handling?
Marieke: Sure. Anna runs the motor team. Tom is our most senior motor handler and he also does fraud investigation with Ruben and Yara.
Marieke: Sanne, Daan, Lotte, Bram, Fatima, Jeroen, Pieter, Eva and Luuk handle motor claims day to day. Noor is still junior, she handles the simple motor claims.
Marieke: Daan, Lotte and Pieter manage the garages, they work in GarageNet all day.
Marieke: Sophie leads property. Thijs handles the large property losses and he goes out with Iris and Mohamed, who do the loss adjusting visits.
Marieke: Julia, Stijn, Femke and Hugo handle property claims. Lisa and Max are our lawyers, they do subrogation.
Marieke: Bram and Stijn sit on the works council, that takes a day a week for them.
Marieke: Eva is our fire warden. Jeroen is on the ClaimsSuite migration project until the end of the year.
Marieke: Sanne and Julia are the key users of ClaimsSuite, they configure it.
Marieke: Ruben and Yara are the fraud experts, Tom knows a lot about fraud as well. Lisa knows subrogation inside out.
Marieke: Kees does the office support for the department.$t$, 'done', 'workbench-fixture'),
       (md5('wb:iv:list')::uuid, md5('wb:ctx:claims')::uuid, NULL, 'workbench-fixture', DATE '2026-09-01',
  'team-list-2026-09.xlsx', 'Name;Role' || chr(10) || 'Sanne Visser;Claims handler' || chr(10) || 'Julia Bos;Key user ClaimsSuite', 'done', 'workbench-fixture');

-- ─── 6. The knowledge objects (under the knowledge roots) ───────────────────
INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "contextCategory", "displayName", description, "createdByUser", "extendedAttributes")
SELECT md5('wb:root:' || t)::uuid, 'manual', 'Identity', t, 'Tag', r,
       'What people are said to hold. Built from confirmed claims (Authorization workbench).', 'workbench', '{"knowledgeRoot":true}'::jsonb
  FROM (VALUES ('Activity', 'Activities'), ('Expertise', 'Expertise'), ('Duty', 'Duties')) v(t, r)
 WHERE NOT EXISTS (SELECT 1 FROM "Contexts" c WHERE c."contextType" = v.t AND c."parentContextId" IS NULL
                     AND COALESCE((c."extendedAttributes"->>'knowledgeRoot')::boolean, false));

-- (person, kind, object, status, quote, source)
CREATE TEMP TABLE wb_claims (n int, kind text, obj text, status text, quote text, src text) ON COMMIT DROP;
INSERT INTO wb_claims VALUES
  ( 5, 'activity',  'Lead the motor team',          'confirmed', 'Anna runs the motor team.', 'marieke'),
  ( 6, 'activity',  'Handle motor claims',          'confirmed', 'Tom is our most senior motor handler', 'marieke'),
  ( 6, 'activity',  'Fraud investigation',          'proposed',  'he also does fraud investigation with Ruben and Yara.', 'marieke'),
  ( 2, 'activity',  'Fraud investigation',          'confirmed', 'he also does fraud investigation with Ruben and Yara.', 'marieke'),
  ( 3, 'activity',  'Fraud investigation',          'confirmed', 'he also does fraud investigation with Ruben and Yara.', 'marieke'),
  ( 7, 'activity',  'Handle motor claims',          'confirmed', 'Sanne, Daan, Lotte, Bram, Fatima, Jeroen, Pieter, Eva and Luuk handle motor claims day to day.', 'marieke'),
  ( 8, 'activity',  'Handle motor claims',          'confirmed', 'Sanne, Daan, Lotte, Bram, Fatima, Jeroen, Pieter, Eva and Luuk handle motor claims day to day.', 'marieke'),
  ( 9, 'activity',  'Handle motor claims',          'confirmed', 'Sanne, Daan, Lotte, Bram, Fatima, Jeroen, Pieter, Eva and Luuk handle motor claims day to day.', 'marieke'),
  (10, 'activity',  'Handle motor claims',          'confirmed', 'Sanne, Daan, Lotte, Bram, Fatima, Jeroen, Pieter, Eva and Luuk handle motor claims day to day.', 'marieke'),
  (11, 'activity',  'Handle motor claims',          'confirmed', 'Sanne, Daan, Lotte, Bram, Fatima, Jeroen, Pieter, Eva and Luuk handle motor claims day to day.', 'marieke'),
  (12, 'activity',  'Handle motor claims',          'confirmed', 'Sanne, Daan, Lotte, Bram, Fatima, Jeroen, Pieter, Eva and Luuk handle motor claims day to day.', 'marieke'),
  (14, 'activity',  'Handle motor claims',          'proposed',  'Sanne, Daan, Lotte, Bram, Fatima, Jeroen, Pieter, Eva and Luuk handle motor claims day to day.', 'marieke'),
  (15, 'activity',  'Handle motor claims',          'proposed',  'Sanne, Daan, Lotte, Bram, Fatima, Jeroen, Pieter, Eva and Luuk handle motor claims day to day.', 'marieke'),
  (16, 'activity',  'Handle motor claims',          'proposed',  'Sanne, Daan, Lotte, Bram, Fatima, Jeroen, Pieter, Eva and Luuk handle motor claims day to day.', 'marieke'),
  (13, 'activity',  'Handle motor claims',          'confirmed', 'Noor is still junior, she handles the simple motor claims.', 'marieke'),
  ( 8, 'activity',  'Manage garages',               'confirmed', 'Daan, Lotte and Pieter manage the garages, they work in GarageNet all day.', 'marieke'),
  ( 9, 'activity',  'Manage garages',               'confirmed', 'Daan, Lotte and Pieter manage the garages, they work in GarageNet all day.', 'marieke'),
  (14, 'activity',  'Manage garages',               'proposed',  'Daan, Lotte and Pieter manage the garages, they work in GarageNet all day.', 'marieke'),
  (17, 'activity',  'Lead the property team',       'confirmed', 'Sophie leads property.', 'marieke'),
  (18, 'activity',  'Handle large property losses', 'confirmed', 'Thijs handles the large property losses', 'marieke'),
  (19, 'activity',  'Loss adjusting visits',        'confirmed', 'Iris and Mohamed, who do the loss adjusting visits.', 'marieke'),
  (20, 'activity',  'Loss adjusting visits',        'confirmed', 'Iris and Mohamed, who do the loss adjusting visits.', 'marieke'),
  (18, 'activity',  'Loss adjusting visits',        'proposed',  'he goes out with Iris and Mohamed', 'marieke'),
  (21, 'activity',  'Handle property claims',       'confirmed', 'Julia, Stijn, Femke and Hugo handle property claims.', 'marieke'),
  (22, 'activity',  'Handle property claims',       'confirmed', 'Julia, Stijn, Femke and Hugo handle property claims.', 'marieke'),
  (23, 'activity',  'Handle property claims',       'confirmed', 'Julia, Stijn, Femke and Hugo handle property claims.', 'marieke'),
  (24, 'activity',  'Handle property claims',       'confirmed', 'Julia, Stijn, Femke and Hugo handle property claims.', 'marieke'),
  (25, 'activity',  'Subrogation',                  'confirmed', 'Lisa and Max are our lawyers, they do subrogation.', 'marieke'),
  (26, 'activity',  'Subrogation',                  'confirmed', 'Lisa and Max are our lawyers, they do subrogation.', 'marieke'),
  ( 2, 'expertise', 'Fraud detection',              'confirmed', 'Ruben and Yara are the fraud experts', 'marieke'),
  ( 3, 'expertise', 'Fraud detection',              'confirmed', 'Ruben and Yara are the fraud experts', 'marieke'),
  ( 6, 'expertise', 'Fraud detection',              'proposed',  'Tom knows a lot about fraud as well.', 'marieke'),
  (25, 'expertise', 'Subrogation law',              'confirmed', 'Lisa knows subrogation inside out.', 'marieke'),
  ( 6, 'expertise', 'Motor claims',                 'confirmed', 'Tom is our most senior motor handler', 'marieke'),
  (18, 'expertise', 'Large losses',                 'confirmed', 'Thijs handles the large property losses', 'marieke'),
  (10, 'duty',      'Works council member',         'confirmed', 'Bram and Stijn sit on the works council, that takes a day a week for them.', 'marieke'),
  (22, 'duty',      'Works council member',         'confirmed', 'Bram and Stijn sit on the works council, that takes a day a week for them.', 'marieke'),
  (15, 'duty',      'Fire warden',                  'confirmed', 'Eva is our fire warden.', 'marieke'),
  (12, 'duty',      'ClaimsSuite migration project','confirmed', 'Jeroen is on the ClaimsSuite migration project until the end of the year.', 'marieke'),
  ( 7, 'duty',      'Key user ClaimsSuite',         'proposed',  'Sanne and Julia are the key users of ClaimsSuite, they configure it.', 'marieke'),
  ( 7, 'duty',      'Key user ClaimsSuite',         'rejected',  NULL, 'list'),
  (21, 'duty',      'Key user ClaimsSuite',         'confirmed', 'Sanne and Julia are the key users of ClaimsSuite, they configure it.', 'marieke');
-- Not known on purpose: Marieke (1), Kees (4), Femke's expertise, Hugo's, Max's — missing is not negative.

INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "contextCategory", "displayName", "parentContextId", "createdByUser", "extendedAttributes")
SELECT gen_random_uuid(), 'manual', 'Identity', t.ct, 'Tag', o.obj,
       (SELECT c.id FROM "Contexts" c WHERE c."contextType" = t.ct AND c."parentContextId" IS NULL
           AND COALESCE((c."extendedAttributes"->>'knowledgeRoot')::boolean, false) ORDER BY c."createdAt" LIMIT 1),
       'workbench', jsonb_build_object('fixture', 'workbench', 'knowledgeKind', o.kind)
  FROM (SELECT DISTINCT kind, obj FROM wb_claims WHERE status IN ('confirmed', 'edited')) o
  JOIN (VALUES ('activity', 'Activity'), ('expertise', 'Expertise'), ('duty', 'Duty')) t(kind, ct) ON t.kind = o.kind
 WHERE NOT EXISTS (SELECT 1 FROM "Contexts" c WHERE c."contextType" = t.ct AND lower(c."displayName") = lower(o.obj)
                     AND NOT COALESCE((c."extendedAttributes"->>'knowledgeRoot')::boolean, false));

INSERT INTO "ContextClaims" ("interviewId", "contextId", "claimKind", "subjectKind", "identityId", "subjectName", "subjectMatch",
                             value, quote, confidence, relevance, "claimStatus", "proposedBy", "decidedBy", "decidedAt", "objectContextId")
SELECT md5('wb:iv:' || w.src)::uuid, md5('wb:ctx:claims')::uuid, w.kind, 'Person', md5('wb:id:' || w.n)::uuid, p.name, 'name',
       w.obj, w.quote, CASE w.status WHEN 'proposed' THEN 0.7 ELSE 0.9 END, 'high', w.status,
       CASE w.src WHEN 'marieke' THEN 'model' ELSE 'analyst' END,
       CASE WHEN w.status = 'proposed' THEN NULL ELSE 'analyst@northwind.example' END,
       CASE WHEN w.status = 'proposed' THEN NULL ELSE now() END,
       CASE WHEN w.status IN ('confirmed', 'edited') THEN (
         SELECT c.id FROM "Contexts" c
          WHERE c."contextType" = CASE w.kind WHEN 'activity' THEN 'Activity' WHEN 'expertise' THEN 'Expertise' ELSE 'Duty' END
            AND lower(c."displayName") = lower(w.obj)
            AND NOT COALESCE((c."extendedAttributes"->>'knowledgeRoot')::boolean, false)
          ORDER BY c."createdAt" LIMIT 1) END
  FROM wb_claims w JOIN wb_people p ON p.n = w.n;

COMMIT;

REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole";
REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments";

SELECT 'workbench fixture loaded' AS result,
       (SELECT count(*) FROM "ContextMembers" WHERE "contextId" IN (md5('wb:ctx:claims')::uuid, md5('wb:ctx:motor')::uuid, md5('wb:ctx:property')::uuid)) AS members,
       (SELECT count(*) FROM "ContextClaims" WHERE "contextId" = md5('wb:ctx:claims')::uuid) AS claims,
       md5('wb:ctx:claims')::uuid AS "claimsUnitId";
