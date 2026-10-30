-- Identity Atlas — how a proposed role is assigned (docs/architecture/m1-discovery-and-design.md,
-- "How a proposed role is assigned").
--
-- Each proposed role of a saved workbench investigation says how it would be
-- assigned — the counterpart of an IGA assignment policy (AssignmentPolicies:
-- Entra access-package auto-assignment / request policies, Omada assignment
-- policies), never written there:
--   assignmentKind  'rule' (assigned automatically — origin Automatic) or
--                   'requestable' (people request it, someone approves — origin
--                   Requested); NULL while the analyst has not chosen
--   membershipRule  the rule: { includeChildren, filters: { <column>: { values,
--                   includeProposed, contains } } } — who holds it (rule) or who
--                   may request it (requestable); NULL = none
--   joinerPolicy    rule: someone who starts matching is added 'auto' or after 'approval'
--   leaverPolicy    someone who stops matching / leaves: 'remove', 'review' or 'keep'
--   approver        requestable: { kind: accountable | owner | person, principalId?, name? }
--   rationale       why the role should exist, in the analyst's words
-- RoleProposalMembers.kind: 'member' — chosen by hand, or "always include" with a
-- rule; 'exclude' — "always exclude" from the rule's matches.
--
-- Additive: no row is changed. Nothing here touches ResourceAssignments.

ALTER TABLE "RoleProposals"
  ADD COLUMN IF NOT EXISTS "assignmentKind" TEXT CHECK ("assignmentKind" IN ('rule', 'requestable')),
  ADD COLUMN IF NOT EXISTS "membershipRule" JSONB,
  ADD COLUMN IF NOT EXISTS "joinerPolicy"   TEXT NOT NULL DEFAULT 'auto' CHECK ("joinerPolicy" IN ('auto', 'approval')),
  ADD COLUMN IF NOT EXISTS "leaverPolicy"   TEXT NOT NULL DEFAULT 'remove' CHECK ("leaverPolicy" IN ('remove', 'review', 'keep')),
  ADD COLUMN IF NOT EXISTS "approver"       JSONB,
  ADD COLUMN IF NOT EXISTS "rationale"      TEXT;

ALTER TABLE "RoleProposalMembers"
  ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'member' CHECK ("kind" IN ('member', 'exclude'));
