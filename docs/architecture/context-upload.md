# Context upload — your own lists as context trees

**Status:** built (first slice). Organisation units and applications only; no
activity / hours import, no sources page, no knowledge graph.

An analyst often has a list the tool cannot crawl: a spreadsheet of customers
with an account manager and the people who work for each, or an application
register with owners and the groups each application uses. *New context tree →
Upload a list* turns such a file into a context tree, and uploading the same list
again updates that tree instead of creating a second one.

## The one decision: an upload is a source

An uploaded list is modelled as a **source system**, not as a fourth context
variant. Everything the tool already does for an imported tree then applies
unchanged:

| Concern | How an upload gets it |
|---|---|
| Where the tree is listed | `variant = 'synced'`, `scopeSystemId` = the list's system → the tree panel shows it under *Imported · Klanten (upload)* |
| Template | `contextType` `OrgUnit` / `LogicalApplication`; the ingest normalisation derives `contextCategory` |
| Owner → Accountable | `ownerUserId` = the owner cell; the synced-owner reconcile (`ingest/contextOwners.js`) states it as the Accountable |
| Members | `ContextMembers`, `addedBy = 'sync'`, through the ingest's context-members path |
| Re-import updates in place | context `id` = deterministic GUID of (list system, tree, key) → same ids every run |
| Removing what left the file | the ingest's full-sync delete, bounded to the list's own contexts by `scopeSystemId` |
| History | the `_history` triggers record every change, as for any source |
| Read-only tree | imported trees are not edited in place; the source (the file) is |

Each list is one `Systems` row: `systemType = 'Upload'`, no tenant,
`displayName = '<list name> (upload)'`. `systemType` is an open vocabulary
(no closed list in the ingest or the ontology), so no vocabulary change is
needed; `Upload` never appears in `assignmentType` or `resourceType`.

### Why not a fourth variant

A `variant = 'uploaded'` would need its own reconcile, its own read-only rule,
its own owner handling and its own tree-panel group — a second copy of each
synced mechanism, kept in step by hand (decision principle A4: reuse the
variant + reconciliation pattern). The only thing an upload adds that a crawler
does not have is *the upload run itself*, which gets its own small table.

## `ContextUploads` (migration 095)

One row per upload run of a list — the history of a list's uploads.

| Column | Meaning |
|---|---|
| `systemId` | the list (FK `Systems`, cascade) |
| `rootContextId` | the root context of the list's (first) tree |
| `fileName` | the file as uploaded |
| `template` | `OrganizationalUnit` \| `LogicalApplication` |
| `keyColumn`, `mapping` | the confirmed mapping (jsonb) — the next re-import starts from it |
| `rowCount` | data rows in the file |
| `created`, `updated`, `unchanged`, `removed` | context counts for the run |
| `unmatchedMembers` | member values that matched nothing |
| `uploadedBy`, `uploadedAt` | who and when |

The context page reads the first and the latest row of its system and shows
*"Uploaded from klanten.xlsx on 3 Oct 2026 by …; last updated by upload on …"*,
and the same facts in *More details*.

Migration 095 also adds an expression index on `lower(email)` of `Principals`:
member matching and the owner reconcile compare e-mail addresses
case-insensitively, and without it each would be a sequential scan.

## Flow

```
POST /api/contexts/uploads/analyze   multipart file (+ listId)
   → parse (csv / xlsx) → column profile → heuristic guess → optional AI refinement
   ← { uploadDraftId, columns[], guess, aiUsed, existingList? }

POST /api/contexts/uploads/preview   { uploadDraftId, mapping }
   ← counts (create / update / unchanged / not in this file), member match
     stats, the first 50 unmatched values, validation errors

POST /api/contexts/uploads/apply     { uploadDraftId, mapping, removeMissing }
   → system (ingest systems path) → contexts (ingest contexts path)
   → members (ingest context-members path) → SameUnitAs links + Responsible
     roles (the add-only context-links ingest internals) → member counts
   → ContextUploads row
   ← result + rootContextId

GET  /api/contexts/uploads           the lists, each with its latest upload
```

All four need `data.write.contexts`.

The file is kept server-side between the steps as a draft: written to
`<UPLOAD_ROOT>/context-uploads/<uuid>.<ext>` with a small JSON sidecar, re-read
by each step (parsing is cheap; nothing is held in memory between requests),
deleted after apply and swept after two hours. There is no small size cap —
the large-file policy holds — but a list over 50,000 data rows is refused with
a sentence saying so.

### Write path

The apply step builds ingest records and runs them through the same internals
`POST /api/ingest/*` uses (`runIngest` in `routes/ingest/handlers.js`, and the
row inserters of `routes/ingest/contextLinks.js`). There is no parallel writer.

- **Contexts.** One batch holds every tree of the list (the full-sync delete is
  scoped to the system, so a batch per tree would delete the other tree).
  Ids are computed with the ingest's own `deterministicGuid`, namespaced per
  tree, and sent with `parentContextId` already resolved.
  `removeMissing = false` (default) runs the batch as a delta — contexts not in
  the file are kept and reported as *not in this file*; `true` runs it as a full
  sync scoped to `{ variant: 'synced', scopeSystemId }`.
- **Members.** One full-sync batch for the list. The ingest bounds that delete
  to memberships of contexts the system owns and never touches an analyst's
  own memberships. A kept context's existing memberships are sent along, so
  keeping a context also keeps its members.
- **Root.** `externalId = '__root__'`, `displayName` = the list name. Rows go
  under it, or under their parent row when a parent column is mapped.

## Mapping

| Field | Meaning |
|---|---|
| `template` | `OrganizationalUnit` or `LogicalApplication` |
| `listName` | root name and system name |
| `nameColumn` | the context's display name |
| `keyColumn` | its `externalId`; defaults to the name column. Re-import matches on it |
| `ownerColumn` | → `ownerUserId` (e-mail, employee id or external id; the reconcile resolves) |
| `responsibleColumn` | → Responsible roles, add-only |
| `parentColumn` | parent key → hierarchy under the root |
| `memberColumns[]` | `{ column, kind: Identity\|Principal\|Resource, shape: list\|long }` — at most two kinds |
| `attributeColumns[]` | → `extendedAttributes`, key = the header as written |

One kind of member per context (the context rule). A second member column of
another kind makes a second tree, *"Klanten · Resources"*, with the same keys,
each pair linked `SameUnitAs`.

**Shapes.** `list`: one cell holds several values split on `;`, `,` or a line
break. `long`: several rows share a key, one member per row; the other columns
are read from the first row of the key.

**Matching order** (first unique hit wins; a value matching two candidates is
ambiguous and unmatched):

- accounts: e-mail / UPN, then `employeeId`, then `externalId`, then exact
  display name when it is unique;
- people: e-mail, then `employeeId`, then exact display name when unique;
- resources: `externalId`, then exact display name when unique.

## The best guess (and the AI)

Deterministic heuristics always produce a complete guess
(`contexts/upload/guess.js`), ported from the Org Info prototype's column
profile and header recognition (`orgtruth/import/profileColumns.js`,
`orgtruth/propose/heuristic.js`, `names.js`): header words in Dutch and English
(*naam/name, eigenaar/owner, leden/members/users/gebruikers,
resources/applicaties/groepen, bovenliggend/parent*), value shapes (e-mail),
and the key = the first unique, fully filled column (a header that says
*id / code / key / nummer* first).

When the report generator's model server is configured
(`NL_REPORTS_LLM_URL`), the guess is offered to it for refinement with a
12-second budget and a JSON schema. Its answer is validated (every column it
names must exist; kinds and templates from the closed lists) and merged field by
field; the fields it changed are returned as `aiFields` so the wizard can mark
them. A slow, failing or invalid answer leaves the heuristic guess untouched.
The AI never blocks an upload and never writes: the analyst's confirmed mapping
is what is applied (decision principle B3).

## Not in this slice

A sources page, a model page, signals, review, the knowledge graph, activity /
hours imports, a downloadable list of unmatched values (the first 50 are shown),
streaming parse.
