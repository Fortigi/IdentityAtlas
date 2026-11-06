# MCP and relative permissions

How the MCP server answers for a person who may see only part of the
organisation (a [context owner](context-owner-access.md)), how that is enforced,
how every answer says what it covers, and the regression suite that keeps it so.

## Assessment: how authorization worked before this change

| Surface | How it decided who sees what | Context owners |
|---|---|---|
| REST API | Role → permissions (`requirePermission`), plus for a caller with no permissions **context-owner mode**: a deny-by-default allow-list of paths (`auth/contextOwnerScope.js`) and data tiers per object (`auth/ownerAccess/tiers.js`) | Scoped correctly; search, list, report and matrix endpoints are simply not on their list (the two report downloads and the team matrix are, with their own checks) |
| MCP server | Role → permissions only (`mcp.use` plus the tool's permission). The tools do **not** call the REST API: they call the report-definition engine (`nlreports/service.js runSpec`), the report registry and name search directly | Refused outright: an owner has no `mcp.use` |

So the premise "MCP is a thin wrapper and inherits the API's authorization" held
for permissions, but not for data scope: the engines MCP calls had no notion of
a scope at all. Giving an owner a role with `mcp.use` would have shown them
everything. Within the engines, everything a scope has to cover runs inside
**one compiled SQL statement**: relation conditions are `EXISTS` subqueries,
relation columns (names, counts, ids) are correlated subqueries, and a grouping
is a `GROUP BY` over the same `WHERE`. A filter on the rows afterwards would
have left the counts, the groupings and the relation columns unscoped. The scope
has to be inside the SQL, before anything is counted.

Other findings:

- **Name lookups** (`nlreports/references.js` — exact name, "did you mean",
  person disambiguation) and **search** read whole tables. Unscoped, they confirm
  that a name exists outside the caller's scope.
- **Comparisons** ("what does X have that Y does not") read the reference
  record's sets through a separate path (`compare.js`).
- **Reports** are global queries. REST lets an owner download exactly two
  (`application-access-review`, `unit-members`) on their own contexts; the MCP
  tools had no such rule.
- **Pre-existing, REST, unchanged here:** a signed-in user whose roles map to no
  permission and who answers for no context still reads every REST read
  endpoint, unless `AUTH_REQUIRED_ROLES` is set (see
  [Remaining risks](#remaining-risks)). MCP never had this gap: it requires
  `mcp.use` or, now, context-owner status.

## What changed

### One rule, two interfaces

The tier rule ("an owner opens a member of their contexts, what members hold,
and an application's holders") is now written once, as SQL predicate builders —
`OPENABLE_SQL` in `auth/ownerAccess/tiers.js`, taking the object's id expression
and the scope parameter. The REST tier statements are generated from them, and
so is the MCP row scope. REST and MCP cannot disagree about who opens what.

### Enforcement points

| What | Where | How |
|---|---|---|
| Who is an owner over MCP | `mcp/auth.js` → `mcp/ownerScope.js` | Exactly the callers REST hands to owner mode (no permission from any role, or missing an `AUTH_REQUIRED_ROLES` role), with **both** switches on: context-owner access and *Context owners may also use the MCP server*. A failed lookup answers 500, never the roleless path. Someone with any permission is never an owner. |
| Which tools an owner gets | `mcp/server.js allowedTools` | Only tools that declare `owner: 'scoped'`. Every tool must declare `scoped` or `refused` (`mcp/tools.guard.test.js`); one without the field is never offered to an owner. |
| What a query reads | `nlreports/scope.js` + `nlreports/compile.js` | `compileSpec(spec, extFields, { scope })` puts the predicate on the report's own table, in every relation condition, on the ids behind a name list and on every other field of a related record. Name lists, counts and a related record's name are read in full, as the app shows them (`isNameOnly`). The context ids are one parameter. A table with no rule throws. Without a scope the SQL is byte-identical. |
| What a lookup finds | `nlreports/references.js` | The same predicate in exact, fuzzy and person lookups and in `searchNames`; fuzzy choices only come from inside the scope. A person, account or resource named exactly that lies outside it is reported as existing (`namesOutsideScope`: `NOT` the predicate) — see [Names outside the scope](#names-outside-the-scope-as-the-app-shows-them). |
| Comparisons | `compile.js`, `service.js` | Refused under a scope instead of half-scoped. |
| Profile photos | `mcp/tools/photos.js` | A photo is more than a name, so it follows the detail-page rule: the accounts the owner may open (`access.accessibleIds`) plus their own. Any other id answers exactly like an unknown one. |
| Which reports run | `mcp/tools/reports.js` | `list_reports` shows only the download allow-list's reports; `run_report` asks the REST allow-list itself (`contextOwnerVerdict` + `settleOwnerVerdict`, exported from `middleware/contextOwnerMode.js`) about the report's download path. Any other report answers exactly like a report that does not exist. |

### Names outside the scope: as the app shows them

The app shows an owner more than the records they may open: a group they may
open lists **every** member, and the ones they may not open appear as grey text
with "No access to details". MCP answers the same way:

| What | Inside the scope | Outside the scope |
|---|---|---|
| The report's own rows (`run_query`) | Listed, all fields | Not listed |
| Name lists and counts of related records (`members.names`, `members.count`, a related record's `displayName`) | Named and counted | Named and counted — as on the record's page in the app |
| Any other field of a related record, a condition on one, the ids behind a name list | Yes | No: a condition cannot match on their attributes, and no id is handed out |
| `search` | Full match: id, link, `accessible: true` | Only on an **exact** full-name match: name, type, `accessible: false`, a note — no id, no link |
| A name in a `run_query` condition | Used | Answered with *"… exists in Identity Atlas, but lies outside the part you may see, so no details about it can be shown"* plus `outsideScope: [{ name, type }]` |
| A name that exists nowhere | — | *"Could not find" / "Did you mean"*, with in-scope suggestions only |

So "does not exist" and "is not yours to see" read differently, as in the app.
Confirming an outside name needs the exact full name, so search cannot list the
organisation; fuzzy suggestions stay inside the scope. People, accounts and
resources only: a context's name outside the scope is never confirmed (the app
does not show those either).

A record's **own** fields stay as they are, including counts stored on or
computed for it (a group's member count, a context's holder count): they are what
its detail page shows, and the record is one the owner may open.

A change (the `change` entity) is visible when its account or its resource
opens, which is what those two objects' timelines show over REST.

### The response contract: `scope`, `truncated`, `total`

Every data result of `whoami`, `search`, `list_reports`, `run_report` and
`run_query` carries:

| Field | Meaning |
|---|---|
| `scope.restricted` | `true` — authorization limited this answer to part of the organisation. `false` — the caller's role reads everything this tool reads. |
| `scope.basis` | `context-owner` or `role` |
| `scope.description` | One sentence for the assistant to relay |
| `scope.contexts` | The owner's own contexts (id, name, role) — never anything about the rest |
| `truncated` | The **row cap** cut the list off. Nothing to do with authorization. |
| `total` / `totalAtLeast` | The full count *within the scope*, when truncated |

The scope block never contains a number, so it cannot leak the size of what lies
outside. The server instructions tell every assistant how to read the block, and
an owner's assistant that it acts for a context owner and must not present a
count as the organisation's total.

## The regression suite

### Layers

| Layer | Tests | What they pin |
|---|---|---|
| A — rules | `nlreports/scope.test.js`, `nlreports/compile.scope.test.js`, `nlreports/references.scope.test.js`, `auth/ownerAccess/tiers.test.js`, `auth/contextOwnerSetting.test.js` | Every catalog table has a scope rule, an unknown one throws, and every relation of the catalog is scoped as a condition and in every column it offers. The compiler walks the catalog, so a relation added later is covered without editing the test. Unscoped SQL is unchanged, and the switches only count together. |
| B/C — MCP units | `mcp/ownerScope.test.js`, `mcp/tools.owner.test.js`, `mcp/tools.guard.test.js`, `mcp/router.test.js` | The sign-in gate (both switches, non-owner, roleful non-owner, failed lookup), every tool passes the scope on, the report gate, the `scope` block |
| B/C — end to end | `contract-tests/authzSecurity.integration.test.js` on real PostgreSQL, real app, real MCP transport | Below |

### The fixture and personas

`app/api/test-utils/securityFixture.js` seeds two units of accounts (one with a
nested sub-unit), an application, a unit nobody in the test owns, overlapping
memberships (Sam in A and B), a group held by both the team and the outsider, an
application holder with access outside it, and a soft-deleted assignment. What
each owner may open is **written out by hand** in the fixture, not computed by
the code under test.

| Persona | Role | Expected |
|---|---|---|
| Admin | `*` | Everything (the positive control) |
| Asker | `mcp.use`, `data.read`, `data.read.reports` | Everything its role reads, unscoped |
| No-MCP reader | `data.read`, `data.read.reports` | MCP refused |
| Carla | Accountable for Unit A | Unit A, its sub-unit, their members and what they hold |
| Dave | Responsible for Unit A (a delegate) | Same as Carla |
| Bob | Accountable for Unit B | Unit B only, not A's sub-unit |
| Mia | Responsible for B, Accountable for App X | The union, including App X's holder but not what he holds elsewhere |
| Olga | No role, no context | MCP refused |

### Coverage matrix

| Scenario | REST | MCP | Outcome tested |
|---|---|---|---|
| Open each fixture object (4 kinds × 4 owners) | detail page by GUID | `run_query` per entity | Both equal the hand-written spec, so they equal each other |
| Object outside the scope, by known GUID | 403 | 0 rows, `restricted: true` | Admin gets it (control) |
| Filter on an outsider by exact name, inside a relation | — | "exists, outside your part", name and type only, no rows | Admin finds the group |
| Filter on a name that exists nowhere | — | "not found / did you mean", never "exists" | |
| Filter on an outsider by id, inside a relation | — | 0 rows | Admin finds the group |
| Filter on an outsider's attribute, inside a relation | — | 0 rows | Admin finds it |
| `none` over a relation as an inverted probe | — | Every in-scope group qualifies | Admin sees the difference |
| Name list / count column on a held group | Lists all, outsider `accessible: false` | Lists all by name, as REST | A group outside the scope is not listed at all |
| What a holder holds elsewhere | — | By name; the group itself does not open | |
| Grouped count | — | Sums to the in-scope total, outsider's group absent | Admin sees it |
| "How many users" | — | In-scope total, `restricted: true`, `truncated` separate | Admin: `restricted: false` |
| Sub-unit people | — | Parent's owner yes, sibling's owner no | |
| Application holder | — | Visible, not what he holds elsewhere | |
| Search | — | Partial name: never the outsider. Exact full name: `accessible: false`, no id/link. Every openable match really opens | Admin finds her |
| Context outside the scope, searched by its exact name | — | Never confirmed | |
| "Did you mean" | — | No out-of-scope names or ids | |
| Data-model reference | — | No record names | |
| Compare | — | Refused | |
| Changes over time | — | Only changes touching an in-scope account or resource | Admin sees the outsider's |
| Report saved by an analyst | 403 | "No report with that name" | Admin runs it |
| Unit report on own unit | 200 | Runs | |
| Unit report on another's unit, an unowned unit, by name | 403 | Refused | |
| Context list, other reports, admin settings, unanchored matrix | 403 | — | |
| Error on a bad definition about the outsider | — | No record data in the error | |
| Owners asked one after another | — | No scope bleeds through a cache | |
| MCP switch off | REST still in | MCP 403 | |

Proof that the suite discriminates: on a real PostgreSQL, four hand-applied
breakages each failed it. Relations unscoped failed 5 tests, the root table
unscoped failed 24, name lookups unscoped failed 4, and the report gate removed
failed 3.

### In CI

- **Every pull request** touching the API: the job **Security: authorization
  regression** (`pr.yml security-authz`, `npm run test:security`) runs the unit
  half and the PostgreSQL half. It feeds **CI Passed**, the required check, so a
  regression blocks the merge.
- **Every push to `main`**, **weekly**, and on demand:
  `security-regression.yml` runs the same suite on the merged result.
- **No external LLM** anywhere in these: every MCP tool is called directly with
  fixed inputs.

## Remaining risks

- **Roleless REST read (pre-existing).** A signed-in user with no permission who
  answers for no context reads every REST read endpoint unless
  `AUTH_REQUIRED_ROLES` is set. Unchanged here, and not reachable through MCP.
  Worth its own issue: deny-by-default for roleless callers.
- **Role-based callers are unscoped by design.** Anyone whose role has `mcp.use`
  and `data.read` sees everything over MCP, as in the app. Their `scope` says
  `restricted: false`.
- **No attribute-level restrictions exist** in the data model today. An owner
  sees every attribute of an object they may open, exactly as its REST detail
  page shows. There is nothing for a test to hold yet.
- **Own facts of an openable record** (a held group's member count) include
  members outside the scope. This is consistent with REST, which lists those members by name.
- **Deployment metadata** in `describe_data_model` (system names, type names,
  context types) is the same for every caller. It is not record data.
- **Prompt injection through data.** A display name can contain instructions to
  the assistant. Authorization is unaffected, because enforcement is server-side, but an
  assistant could be talked into misreporting. Not addressed here.
- **Exploratory LLM-driven testing** (a real model probing for leaks, or judging
  whether restrictions are communicated) is not built. The deterministic suite
  is the gate. Such a run would complement it, weekly, with its own budget.
- **Token verification is mocked** in the end-to-end suite. Signature, issuer,
  audience and tenant checks are covered by `middleware/jwtValidation.test.js`
  and `mcp/router.test.js`.
- **Not exposed over MCP at all**: the matrix, saved investigations, change
  requests. If a tool is added for them, the guard test forces a decision on
  `owner`, and this suite should gain its scenarios.
