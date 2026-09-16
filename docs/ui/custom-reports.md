# Custom Reports

!!! note "Experimental"
    Custom reports are off until an operator switches them on under
    **Admin → Experimental**. The "describe it in plain language" half also needs the optional
    [report generator](../reference/report-generator.md) container. Everything else works without it.

The **Reports** tab lists the reports this deployment offers. Next to the ones that ship with
Identity Atlas, you can build your own: pick what to report on, add conditions, choose columns, and
save it. A saved report behaves exactly like a built-in one — it opens in its own tab, runs against
the latest data every time, and can be downloaded.

You need the **Build custom reports** permission (`data.write.reports`). Everyone who can read data
can open, run and download the result.

## Building a report

**Reports → New report** opens the report builder in its own tab.

1. **Name it.** The name is what colleagues see in the list, so make it the question it answers —
   "Guests without an active manager" rather than "report 3".
2. **Choose what to report on:** Users, Groups, Accounts (including service principals, managed
   identities and AI agents), Resources (roles, applications, permissions, business roles, Azure
   resources) or Persons (identities, with their linked accounts).
3. **Add conditions.**
      - **+ condition** — a field of the thing itself: *Enabled is No*, *Name contains LIC*,
        *Created is more than 90 days ago*, *Group count is more than 30*.
      - **+ related condition…** — something about what it is connected to: *has no Manager*,
        *has Manager where Enabled is No*, *is a member of a group where Name contains LIC*,
        *has no Owners*.
      - **+ any/all group** — for an either/or: *any of: has no owner · has an owner where Enabled is No*.
      - **+ compare with…** — see [Comparing with another group or person](#comparing) below.
4. **Pick columns.** Click a column name to add or remove it. Besides the fields themselves you can
   show things like the manager's name, the groups someone is in, or a count.
5. **Preview.** The builder shows *what will run* in plain language, the number of rows, and the rows
   themselves. Read the plain-language version before you trust the result — that sentence is
   generated from the definition that actually runs.
6. **Save.** The report appears in the list for everyone, marked **custom**.

Rows are clickable: a row about an account opens that account's detail tab.

## Describing it in plain language

When the report generator is deployed, the builder has a **Describe it** box. Type what you want:

> Guest accounts that don't have a manager, or whose manager is disabled

The model turns that into a report definition. It never sees your data — only your question and the
list of fields it may use. What comes back is always shown as editable criteria plus the
plain-language reading, because **the model is often right but never guaranteed to be right**. Check
it before you save.

The generator may answer with a question instead of a report:

- **"Did you mean…?"** — you named something (a business role, a group, a person) whose name does not
  match exactly. Pick the right one, type the exact name, or keep what you wrote.
- **A clarifying question** — the request is ambiguous in a way that changes the result ("everyone
  with admin rights" — which kind?). Answer it, or ask it to use its best guess.
- **"I cannot build this"** — the report needs information Identity Atlas does not hold. Asking for
  users who have not signed in for 90 days gets you a note that there is no sign-in date to filter
  on, rather than a report built on the wrong field.

You can keep talking to it: *"only enabled accounts, and show the department"* updates the definition
you have, including any changes you made by hand.

The first question after an update, or after the model has been idle, takes longer — the builder says
so while it warms up.

## Comparing

Role-mining questions compare two sets of members rather than filtering rows. **+ compare with…**
reads as a sentence:

> has **exactly the same** **Members** as **resource** "Fortigi - Algemeen - Maten"

- **exactly the same** — identical membership.
- **contains all of** — has everything the other one has, and possibly more.
- **only items also in** — has nothing the other one does not have.
- **mostly the same (≥ %)** — overlaps by at least the percentage you set.

You can compare members of groups, the groups someone is in, what an account has access to, owners,
and the accounts of a person.

A comparison adds three columns automatically: **Similarity %**, what is **only here**, and what is
**missing** compared with the reference. Results are sorted by similarity, so the closest matches are
at the top.

Combine it with an ordinary condition to get the question a role-mining analyst actually asks:

> Groups that have the same members as business role "Fortigi - Algemeen - Maten", but which are not
> part of that business role

## What it cannot do

- **No free-form SQL.** Everything is built from the fields and relations Identity Atlas knows about,
  which is also why a report can never change or delete data.
- **No totals or grouping** beyond the counts offered as fields (members, groups, owners, accounts).
- **No history or trends** — a report always reflects the data as it is now.
- **No comparing two fields of the same record** (for example: people whose department differs from
  their manager's).
- **One step at a time** in a relation: "groups whose owner is disabled" works; "groups whose owner's
  manager is disabled" does not.
- **Only data Identity Atlas holds.** If a crawler does not collect it, no report can show it.

## Editing, deleting and sharing

- **Edit** a custom report from the list, or from the report tab itself. The definition, name and
  description can all change; the report keeps its link.
- **Delete** removes it for everyone.
- Custom reports are **shared across the deployment**: everyone sees the same list, and the list shows
  who created and last changed each one. They are not personal drafts.
- A report remembers the *record* it compares against, not just the name, so renaming a business role
  does not break a saved comparison.
