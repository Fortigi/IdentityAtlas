# Change requests — what should change in the source

**Status:** built (first slice): one kind of change request, raised by one kind of
decision. Routing (who receives it, and how) is deliberately not built yet.

Identity Atlas reads its data from sources: crawled systems, uploaded lists, rules
that derive contexts. When an analyst decides that a source is wrong, for example
*"the interview is right: Led left, even though the Klanten list still lists him"*,
Identity Atlas shows the corrected picture at once (a [member
override](context-interviews.md#marked-former-by-a-decision-migration-099)). The source itself is
still wrong, and the next re-import brings the same wrong fact back. The override
keeps the decision in force **until the source is corrected**. A **change request**
records that correction, and says which source it is for and what should change there.

## Who owns the fact decides whether there is one

| The fact is owned by | A correction in Identity Atlas is | Change request? |
|---|---|---|
| **A source** that Identity Atlas mirrors: a crawled system, a list that gets re-imported | an override on top of the source | **yes**, one per source to correct |
| **Identity Atlas itself**: a context or a member list kept by hand, a master structure built in the tool | the truth itself, overriding nothing | **no**. Other sources are *mapped* to it, not corrected |
| **A rule** that derives the context (the manager hierarchy, for example) | an override on top of the rule's output | **not yet**: the fix belongs in the rule's input (a manager attribute in HR), which this slice cannot yet name |

A list uploaded once and never again is still a source: its change request stays open
and does nothing until someone re-imports it. Whether a source is *frozen* or
*correctable* (`correctionPolicy`) is a follow-up. So is routing to the people who
can make the change.

## Override and change request are two things

- The **override** is local: it decides what Identity Atlas shows, and acts at once.
- The **change request** is outward: it says what should change in the source. It can
  stay open for months.

A change request rests on the claim and the override that caused it. Undoing the
decision withdraws it.

## The kinds

The five kinds of change that cover a source's data. They follow the entity /
relationship / attribute split used by other identity-analytics tools, with
"relationship change" split into add and remove:

| `changeKind` | Example |
|---|---|
| `EntityCreate` | the source misses a unit that exists |
| `EntityDelete` | the source lists a unit that no longer exists |
| `RelationshipAdd` | Klaas should be listed as the application's owner |
| `RelationshipRemove` | Led should no longer be listed as a member of Klanten |
| `AttributeUpdate` | the owner field should read Klaas, not Piet |

This slice raises only `RelationshipRemove`, from a member override. The others are
in the value list, so the next producers (an ownership survey, a changed owner) need
no migration.

## The data closes it, not a person

A change request is **open** until the source shows the change. Every read of the list
first checks the open requests against the data as it is now:

- **Resolved:** the source no longer lists the member (a re-import or sync dropped
  them), or no longer has the unit at all. The request records when and why. The
  override then has no member to sit on, and stops counting.
- **Withdrawn:** the decision it rests on was undone, or a later confirmed claim says
  the person is in the unit after all.

Nobody ticks "done": the next re-import proves it. The statuses a person sets, such as
*sent* or *rejected by the source owner*, come with routing.

## Data

`ChangeRequests` (migration 103), recorded in `_history` like the claims and overrides
it rests on:

| Column | |
|---|---|
| `changeKind` | one of the five kinds above |
| `targetSystemId`, `targetName` | the source to correct, and its name when raised (it survives the system's removal) |
| `contextId`, `contextName`, `memberId`, `memberName` | what it is about, with the names at the time it was raised |
| `attribute`, `currentValue`, `expectedValue` | for `AttributeUpdate` |
| `summary` | one line a person can act on: *"Remove Led from Klanten"* |
| `requestStatus` | `open`, `resolved` or `withdrawn` (the API calls it `status`) |
| `basisClaimId`, `overrideId` | the claim and the override it rests on |
| `raisedBy`, `raisedAt`, `closedAt`, `closedReason` | |

At most one open request per kind, source, context and member. Deciding the same thing
twice updates the open request instead of adding a second one.

In the ontology it is `ia:ChangeRequest`, under `ia:Knowledge`. Like a claim, it is
never a way of holding access.

## Where it shows

- **API:** `GET /api/change-requests` (filters: `status`, `systemId`, `contextId`).
- **Context page:** a *Change requests* panel lists the open requests for that unit,
  with their source.
