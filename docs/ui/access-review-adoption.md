---
type: task
prereq: sync/entra-id.md
outcome: You can see which business roles a person has really reviewed, which only ever completed automatically, and which reviewers to follow up with or thank.
---

# Access review adoption

Two standard reports on the **Reports** page show whether access reviews are actually being done:

- **Access Review Adoption** has one row per business role.
- **Access Reviewer Response** has one row per reviewer.

Both download as CSV, as JSON, and as an Excel workbook with pie charts and pivot tables.

## Why "completed" is not "reviewed"

In Entra ID an access review completes even when nobody looks at it. When the deadline passes, the
setting *If reviewers don't respond* applies its default decision: approve, deny, or follow the
recommendation. The review is then closed, and every item carries a decision.

A compliance view that counts closed reviews therefore reports those roles as reviewed. These two
reports do not. A decision only counts when a **person** made it:

- the decision is not *Not reviewed* (or another source's "no response" value), and
- a reviewer is recorded on it, and
- that reviewer is not the platform itself. Entra ID records decisions it applied with the reviewer
  *AAD Access Reviews* and an all-zero id.

## Access Review Adoption: per business role

Each role gets one status. The list is sorted worst first, and within a status by the last review a
person did, longest ago first.

| Status | Meaning |
|---|---|
| **No review yet** | No review has ever been held for this role. |
| **Never reviewed by a person** | Reviews were held, but every one completed without a person deciding. |
| **Latest review not by a person** | A person reviewed it once, but the latest review completed automatically. |
| **Latest review partly by a person** | In the latest review a person decided some items, and the rest were applied automatically. |
| **Reviewed by a person, too long ago** | The latest review was done by a person, but longer ago than the threshold (365 days by default). |
| **Reviewed by a person** | The latest review was done fully by a person, recently. |
| **Review in progress** | The latest review is still open, so there is no verdict yet. |
| **New, no review yet** | The role has no review yet and is younger than the threshold (90 days by default). This is expected, not a gap. |

Besides the status, each row shows:

- when a person last reviewed the role, how many days ago, and who it was,
- how many members the role has,
- how many review rounds were held and how many had a person in them,
- how the latest round split between decisions by a person and decisions that were not,
- the role's *default decision* setting.

Both thresholds are settings of the report. You can store your own as a saved view.

**Roles that do not require a review are left out.** A role is left out when it has assignment policies,
none of them has *Require access reviews* switched on, and it has never been reviewed. A notice above
the table says how many roles were left out. Switch on **Include roles that do not require a review** to
show them; the *Review required* column then says *No* for them. A role is never left out when there is
no policy information for it, or when it was reviewed anyway.

## Access Reviewer Response: per reviewer

This report shows who was asked to review and whether they did it themselves.

| Column | Meaning |
|---|---|
| **Reviews asked** | Review rounds that ended in the period in which this person was a reviewer. |
| **Reviews answered** | Of those, the rounds in which they made at least one decision themselves. |
| **Reviews missed** | Asked minus answered. |
| **Response %** | Answered as a share of asked. |
| **Approved % / Denied %** | How their own decisions split. A reviewer who approves everything without ever writing a justification may be clicking through. |
| **With justification %** | How often they explained a decision. |
| **Open reviews** | Rounds still running. These are never counted against anyone. |

The verdict follows from the response rate:

| Verdict | Response rate |
|---|---|
| Never responded | 0% |
| Mostly does not respond | below 50% |
| Responds sometimes | 50% to 89% |
| Reviews consistently | 90% or more |
| Only open reviews | The reviewer was only asked in reviews that are still running. |

The people to follow up with are at the top, and the people to thank are at the bottom. The period is
a setting (365 days by default).

!!! note "Run a full Entra ID sync first"
    Who was *asked* to review is collected by the Entra ID crawler from the reviewers each review
    contacted. Data synced before this was added only shows reviewers who made a decision. Until the
    next full sync, nobody can show up as *Never responded*, and the report says so above the table.

## The Excel download

**Download XLSX** opens on these tabs:

1. **Summary**: the counts and the rule the statuses were judged by.
2. **Charts**: two pie charts with their numbers beside them.
    - Adoption shows roles by status, and role members by status.
    - Response shows reviewers by verdict, and missed reviews by verdict.
3. **Data**: the table, with filters.
4. Two **pivot tables**.
    - Adoption has *By status* and *By system*.
    - Response has *By verdict* and *By department*.
