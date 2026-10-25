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

## `ContextUploads` (migration 097)

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

Migration 097 also adds an expression index on `lower(email)` of `Principals`:
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
  The batch is always a full sync scoped to `{ variant: 'synced', scopeSystemId }`
  — a delta would keep a stored value for a cell the file has emptied
  (`COALESCE`). With `removeMissing = false` (default) the contexts not in the
  file are kept by sending them back unchanged, and reported as *not in this
  file*; with `true` they are left out, so the full sync removes them.
- **Members.** One full-sync batch for the list. The ingest bounds that delete
  to memberships of contexts the system owns and never touches an analyst's
  own memberships. A kept context's existing memberships are sent along, so
  keeping a context also keeps its members. (An upload whose member columns
  match nobody at all sends an empty batch, which the ingest treats as "nothing
  to say": the previous memberships then stay.)
- **Batch size.** The ingest takes 50,000 records per batch; two trees of a
  large list, or its memberships, can be more, and then go as one ingest
  session (start / continue / end), which reconciles at its end exactly as one
  batch would.
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

**SharePoint cells** (`contexts/upload/cellValues.js`). A person or lookup
column exported from SharePoint reads `Alice Example;#27;#Bob Sample;#16`:
such a cell splits on `;#` and the lookup ids are dropped. A person claim
(`i:0#.f|membership|alice@example.com`) and `Name <address>` become the
address. The owner cell is read the same way but never split on a comma
(`Example, Alice` is one owner). The column profile reports such a column as
shape `lookup`, and an unlabelled multi-valued one is guessed as accounts.

**Matching order** (first unique hit wins; a value matching two candidates is
ambiguous and unmatched):

- accounts: e-mail / UPN, then `employeeId`, then `externalId`, then the name;
- people: e-mail, then `employeeId`, then the name;
- resources: `externalId`, then exact display name when unique.

**The name** (`lib/nameMatch.js`, shared with the owner resolution of the
contexts ingest). Both sides are normalised: accents dropped, case and extra
whitespace ignored, one trailing ` | Org` or ` (Org)` dropped, `Last, First`
read as `First Last`, dots / hyphens / underscores read as spaces. A
normalised-equal name matches when exactly one **user** account has it (else
exactly one principal of any type) — reported as *by name*. Failing that, a
**near miss**: Jaro-Winkler ≥ 0.93 on the normalised names and at least 0.03
ahead of the runner-up — reported as *fuzzy*, and every fuzzy match is listed in
the preview as *value → account* (the first 50) before anything is written. A
runner-up closer than that is ambiguous, never a guess. Name candidates come
from a trigram lookup per value (`<%` word similarity: the displayName index
of migration 013 for accounts, the search index of migration 091 for people).

**Owners.** The preview matches the owner column the same way and reports
resolved / by name / fuzzy / not found with samples. On apply every matched
owner is written as the unit's Accountable (insert-only, `addedBy 'sync'`),
next to the contexts ingest's own resolution (`ingest/contextOwners.js`:
externalId, employeeId, e-mail, then the normalised name). The ingest does
**not** take near misses: deciding one needs a runner-up per owner across the
whole directory, which for a crawl of thousands of owners against hundreds of
thousands of accounts is not a cheap set-based step; its name step is an index
lookup per still-unresolved owner plus an equality test.

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
