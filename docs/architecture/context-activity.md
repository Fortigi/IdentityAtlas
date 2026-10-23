# Context activity — who works on what, as evidence

**Status:** built (first slice). Upload, preview, import, the Activity section on a unit or
application, the per-child table on a parent, and undo. Not yet: feeding the suggestions into
*Review team members*, scheduled imports, an API-key push of activity.

An analyst often knows who *works* on something from a source that says nothing about access: a
time registration (a Clockify export: hours per person per customer and project), the audit log of
a SharePoint library (who opened and edited what). *Actions → Upload activity* on an organisation
unit or an application — also on the **root** of a tree, such as the root of an uploaded customer
list — imports such an export, and the context page then compares who was active with who is a
member.

## The one decision: activity is evidence

Activity is **evidence of who works on what**. It is not access and it is not membership:

- it never changes `ContextMembers` (who belongs to a context) — an active person is not added, an
  idle member is not removed;
- it never touches `ResourceAssignments` (who holds what) — the holding rule of the
  [core ontology](core-ontology.md#three-layers-one-way-of-holding) is unchanged;
- what it can do is **suggest**: *active, not a member* and *member, no activity in the period* are
  questions for a member review, not edits.

In the ontology (version 2.2.0) this is `ia:Evidence`, a third kind of table beside nodes and edges:
`ia:Activity` (`ContextActivity`) is one observation — a subject (an account, a person, or a name
that matched neither) did an amount of activity on a context on a date, reported by one upload of a
source — and `ia:ActivityUpload` (`ContextActivityUploads`) is that upload.

## Tables (migration 096)

`ContextActivityUploads` — one row per upload run.

| Column | Meaning |
|---|---|
| `contextId` | where it was uploaded: a unit, or the root / parent whose sub-units the rows name (cascade) |
| `fileName`, `sourceLabel` | the file, and its source (`Clockify`, `Microsoft 365 audit log`, or a name from the file name) |
| `mapping` | the confirmed mapping (jsonb); the next upload of the same source on this context starts from it |
| `periodStart`, `periodEnd` | the first and last date in the file |
| `rowCount`, `matchedRows`, `unmatchedRows` | data rows; rows imported; rows not imported (no date, amount or person, or a sub-unit that matched nothing) |
| `uploadedBy`, `uploadedAt` | who and when |

`ContextActivity` — one row per imported row.

| Column | Meaning |
|---|---|
| `uploadId` | the upload (cascade: undo removes its rows) |
| `contextId` | the context the row landed on (cascade) |
| `principalId`, `identityId` | the matched account and person; NULL for a name that matched nobody. `ON DELETE SET NULL`: removing an account keeps the observation, with its raw name |
| `subjectName`, `subjectEmail` | the subject as the file wrote it |
| `activityDate`, `amount`, `unit` | the day; how much; `hours` or `events` |
| `kind` | what kind of activity (Clockify's Task, an audit log's Operation), when mapped |
| `attributes` | the other columns the analyst kept (Description, Tags …), by header |

Indexes: `(contextId, activityDate)` for the section, `(principalId)`, and `(uploadId, activityDate)`
for the replace step.

### Re-upload replaces the overlapping period

Time exports overlap: January–March, then February–April. A new upload for the **same context and
the same source label** (compared case-insensitively) first deletes the rows of earlier uploads of
that context and source whose `activityDate` falls in the new file's `[first date, last date]`, then
inserts its own — one transaction. Rows of earlier uploads outside that range stay. Nothing is
counted twice, and an earlier upload whose rows were all replaced stays in the history with *0 rows
held*. Another source on the same context (a library audit log next to Clockify) is never touched.

The preview says what would be replaced: how many rows, from which earlier uploads.

### Undo

`DELETE …/activity/uploads/:uploadId` removes one upload made on that context and every row it still
holds. An upload made on a root is undone on the root's page.

## Flow

```
POST /api/contexts/:id/activity/analyze   multipart file
   → parse (upload/parse.js, up to 500,000 rows) → column profile (upload/profile.js)
   → heuristic guess (activity/guess.js) → saved mapping of the same source, or optional AI refinement
   ← { uploadDraftId, columns[], guess, aiUsed, aiFields, hasChildren, subUnitCount, previousUpload }

POST /api/contexts/:id/activity/preview   { uploadDraftId, mapping }
   ← rows readable / skipped (with samples), period, sub-unit matching (key / name / fuzzy /
     ambiguous / not found, with the rows each miss holds back), people matching, what is replaced

POST /api/contexts/:id/activity/apply     { uploadDraftId, mapping }
   → replace + insert in one transaction (activity/store.js)
   ← { uploadId, imported, replaced, notImported, period, subjects }

GET    /api/contexts/:id/activity?from&to           the four groups
GET    /api/contexts/:id/activity/summary?from&to   per sub-unit × month
GET    /api/contexts/:id/activity/uploads           history
DELETE /api/contexts/:id/activity/uploads/:uploadId undo
```

Writes need `data.write.contexts`; reads need `data.read`. The upload is offered on organisation
units and applications only (the API refuses other templates). The context-owner allow-list
(`auth/contextOwnerScope.js`) does not include these paths: a context owner's read-only page shows
no activity in this slice.

## Reuse

The list upload's pieces do the work; the activity code adds only what is specific to activity.

| Piece | From the list upload |
|---|---|
| reading csv / xlsx, header detection, the row cap | `upload/parse.js` (`parseList` with a `maxRows` of 500,000) |
| the file between the steps | `upload/drafts.js` |
| column profile | `upload/profile.js` |
| header words (Dutch compounds, CamelCase) | `upload/guess.js` `says` / `squash` / `listNameFrom` |
| mapping column checks | `upload/mapping.js` `columnOrNull` / `checkAttributes` |
| SharePoint person cells, claims | `upload/cellValues.js` `singleValue` |
| people matching (e-mail, employee id, name, near miss) | `upload/members.js` `loadCandidates` / `buildMatcher` and the match stats |
| sub-unit name matching | `lib/nameMatch.js` |
| the model refinement | `upload/aiRefine.js` (`askModel`, `withTimeout`, the 12-second budget) |
| the multipart intake and failure answers | `routes/contexts/uploads.js` (`fileReceiver`, `sendFailure`) |

## Mapping

| Field | Meaning |
|---|---|
| `sourceLabel` | the source; a later upload of the same source on this context replaces the overlap |
| `contextColumn` | the column naming the sub-unit a row lands on — only on a context with sub-units; without it every row lands on the context itself |
| `subjectNameColumn`, `subjectEmailColumn` | who did it; at least one |
| `dateColumn`, `dateOrder` | the date; `dmy` or `mdy` for 05/03/2026 |
| `amountColumn`, `unit` | `hours` (decimal, `h:mm[:ss]`, `1h 30m`) or `events`; without an amount column every row is one event |
| `kindColumn` | what kind of activity |
| `attributeColumns[]` | kept on each row |

**The guess** (`activity/guess.js`). Two exports are recognised by their headers: Clockify (five or
more of *Project, Client, Description, Task, User, Email, Tags, Billable, Start Date, Start Time,
End Date, End Time, Duration (h), Duration (decimal)*) and a Microsoft 365 audit log (*CreationDate,
UserIds, Operations, AuditData*); anything else is named after its file. The **context column** is
the column whose values name the most sub-units (by key or name) — on a customer tree that is
Clockify's *Client*, or its *Project* when the projects are the units — and, when no value names a
sub-unit, a header that says client / customer / project / team. The amount is *Duration (decimal)*
before *Duration (h)* before any duration or hours column, never a money column (*Billable amount*,
*rate*) and never a clock time (*Starttijd*). The date is *Start Date*, else a header that says
date whose values are dates, else the first column of dates; its order is month-first only when a
value can only be month-first (`04/18/2026`) and none can only be day-first.

**Dates** (`activity/values.js`): ISO (an xlsx date cell arrives as one), `yyyy/m/d`, `d-m-yyyy`,
`d.m.yy`, `m/d/yyyy` with `dateOrder`, a time after the date ignored, and Excel serial day numbers
(1970–2100). A date that does not exist (`31-02-2026`) skips the row.

**The AI**: as for the list upload — only when `NL_REPORTS_LLM_URL` is set, 12 seconds, a JSON
schema, every field it answers checked against the file and taken only when it adds no problem; the
fields it changed are marked in the wizard. It never blocks and never writes. A saved mapping of the
same source, when it still fits the file, is used instead of asking.

## Matching

**Sub-units**: every context below the uploaded-on one (all levels). A value matches a sub-unit's
key (`externalId`, case-insensitive) first, then its name through `lib/nameMatch.js` (normalised,
then a near miss ≥ 0.93 with a clear margin, reported as *fuzzy* and listed in the preview). A value
two sub-units share is ambiguous; its rows — and the rows of a value that matches nothing, or an
empty cell — are not imported, and the preview lists them with the rows each holds back.

**People**: the list upload's matcher, for accounts and for people: the e-mail address first, then
the name. A subject matched only as an account gets its person through `IdentityMembers`; one matched
only as a person gets its primary account. A name that matches nobody is imported anyway, as
*active, unknown person*.

## The Activity section

**One context** (`GET …/activity`). The period defaults to the twelve calendar months up to the
latest activity on the context. Each person: amount (in the unit most rows are in), first and last
date, amount per month. Four groups against the context's **current** members — compared on the
person for a unit of people, on the account for a unit of accounts:

| Group | Meaning |
|---|---|
| member and active | a member with activity in the period |
| active, not a member | a known person with activity who is not a member — a suggestion |
| member, no activity in period | a member without activity in the period — a suggestion |
| active, unknown person | activity by a name that matched nobody |

A context of resources (an application's) has no people to compare: its groups are *active* and
*active, unknown person*.

**A parent** (`GET …/activity/summary`): one line per direct sub-unit over its whole subtree (a row
on a grandchild counts for its child) — total, active people, *active, not a member* (judged on the
context the row landed on), *member, no activity* (the sub-unit's own members), and the amount per
month — and a totals line. The table is clickable to the sub-unit.

The analyst (with `data.write.contexts`) sees the upload card and Undo in the history; a business
reader sees the section read-only.
