# `identityType` on the `Identities` Table — Design Decision Pending

> **Status:** Pending design discussion — do NOT implement until decided.

---

## Background

`ResourceAssignments` now supports `identityId` as an alternative to `principalId` (migration 036, June 2026). This means access can be assigned to a correlated identity rather than to a specific account. Both assignment targets coexist; the choice is per-organisation and per-account-type.

This change exposed a gap: the `Identities` table has no column that describes *what kind of entity* the identity represents. Until now, Identities were implicitly assumed to be humans, but IGA systems regularly model technical accounts (service accounts, machine accounts, functional mailboxes) as first-class identities too — and those can now receive `identityId`-targeted resource assignments.

The `principalType` column on `Principals` already makes this distinction at the account level. A parallel `identityType` on `Identities` is needed to make it at the identity level.

## Current State

- `Identities` table: no `identityType` column.
- The Omada crawler uses an internal `identityTypesForIdentityTable` config to decide which Omada identity types get a row in the `Identities` table (currently only person-type identities). This is a convention, not enforced by the schema.
- Crawlers that write technical-account identities today should use `extendedAttributes` as a workaround.
- `tools/crawlers/CLAUDE.md` documents the proposed values as guidance for crawler authors.

## Proposed Values

| Value | Description |
|-------|-------------|
| `Person` | Human identity — the standard case |
| `ServiceAccount` | Technical / functional / service account modelled as an identity in an IGA system |
| `MachineAccount` | Non-human machine or device account |

## Open Questions

1. **Column type and nullability** — nullable TEXT (backward-compatible) or NOT NULL with a default of `'Person'`?
2. **Migration scope** — backfill existing rows as `'Person'`, or leave NULL and treat NULL as `'Person'`?
3. **Omada crawler** — update `identityTypesForIdentityTable` logic to also write `ServiceAccount` / `MachineAccount` identities when the IGA system models them?
4. **UI impact** — should the matrix view, identity detail page, and account-linking logic filter or label by `identityType`?
5. **Account correlation** — should the correlation algorithm treat `ServiceAccount` identities differently (e.g. skip name/email matching)?

## Related

- `docs/architecture/resource-assignments-identity-support.md` — the migration 036 design doc
- `tools/crawlers/CLAUDE.md` § `principalType` and `identityType` Values
- `app/api/src/db/migrations/036_resource_assignments_identity_support.sql`
