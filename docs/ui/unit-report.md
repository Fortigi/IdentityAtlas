---
type: task
prereq: ui/contexts.md
outcome: You can download, for an organisational unit of accounts or people, a spreadsheet of its members with how many entitlements each holds, and everything known about the unit itself.
---

# Unit report

The **Unit report** lists the members of an organisational unit, one row each. It works on a unit of
**accounts** (for example a department of Entra accounts) and on a unit of **people**.

Download it from the unit's page (**Actions › Download unit report**), or run it from the **Reports**
page and pick one or more units. A unit of *resources* has no unit report; use the Entitlement Pivot
for that.

## What the spreadsheet holds

The **Summary** tab describes each unit in full, the same way the
[Entitlement Pivot](entitlement-pivot.md) does: who is Accountable and Responsible (name, employee ID,
e-mail) — or, when nobody is Accountable yet, the suggested person and why — and every attribute the
unit's page lists under *More details*. It also says how the entitlement count was made.

The **Data** tab has one row per member:

| Column | Accounts | People |
|---|---|---|
| Unit, Name, Status, Email, Employee ID, Job title, Department, Manager | yes | yes |
| Account type, Enabled, System | yes | — |
| Linked accounts | — | yes |
| **Org claim — Status**, **Org claim — Role**, **Org claim — Source** | yes | yes |
| **Entitlements** | distinct resources the account holds | distinct resources held across every account linked to the person, plus any assigned to the person directly |
| every attribute the members carry | yes | yes |

Entitlements count live assignments only. Business roles are not counted; the entitlements a role grants
are. After the fixed columns comes a column for every attribute the source stored on the members, sorted
by name — at most 60; if there are more, the ones most members carry are kept and the rest are named on
the Summary tab.

## Organisational claims

Three columns, with a light amber header, say what people told us about each person — in interviews,
notes, files and other information added on the unit's page — rather than what a connected system says:

- **Org claim — Status**: the status the unit's **People** overview shows — *Current*, *Came back*,
  *Not confirmed*, *Left (decided)* or *Left*.
- **Org claim — Role**: their latest role there, and for someone who came back the roles of their
  earlier stint ("Analyst · earlier: Junior analyst").
- **Org claim — Source**: where that comes from, short: "interview with …, date", "file …, date" or
  "notes added by …, date".

A claim nobody has reviewed yet is marked **(proposed)** — "Data mining (proposed)"; a confirmed one is
plain. The columns are empty for a person nobody said anything about. A context owner, and anyone who
cannot edit contexts, sees confirmed claims only — the same rule as the People overview.

After the members follow the people the added information names but the member list does **not** list —
*Not confirmed* first, then *Left*. Their **Status** column says "not listed by the source", and their
entitlements are still counted, so the sheet answers "do they still have access?". With sub-units
included, these rows are added for the picked unit only.

On the Summary tab, under the people block of each unit, a note explains the Org claim columns, followed
by the number of current members, former people and (for analysts) claims still proposed.

## Sub-units

By default the report lists the unit's **direct** members. Tick **Include sub-units** (parameter
`includeSubUnits=true`) to also list the members of every unit below it; each row then says which unit
it came from.
