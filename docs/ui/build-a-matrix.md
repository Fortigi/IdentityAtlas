---
type: task
prereq: start/first-15-minutes.md
outcome: You can build a matrix that answers one question, tell from the live counts whether it will load, save it under a name, and reopen and adjust it later.
---

# Build a matrix

!!! info "Before this page"
    Assumes you have done **[Your first 15 minutes](../start/first-15-minutes.md)** and know the words *account*, *identity*, *resource*, *assignment* and *context* from **[The words you need first](../start/glossary.md)**.

A matrix is a question with two sides: *these people* against *these resources*. You build one whenever you have such a question — "what does Engineering hold?", "who can reach the finance systems?", "which access in this department did nobody design?". Every account against every resource is not a question, and it would not fit on a screen either, so nothing loads until you have chosen both sides.

You make that choice in a wizard with four steps.

---

## Where to start

Click **Matrix** in the top navigation. What you see depends on what is already there:

- **Open a matrix** — the list of saved matrices. Click **New matrix**.
- **A matrix is already on screen** (your organisation's default matrix opens by itself, if one is set). Click the matrix name in the strip above the grid and choose **New matrix…**.
- **No data available yet** — nothing has been imported. Run a crawler or load the demo data first; see [Quick Start](../quickstart.md).

The wizard opens with the title **Create matrix**. The four steps are shown at the top — **Subjects**, **Resources**, **Layout**, **Save & share** — and you can click any of them to jump there. **Next** and **Back** walk through them in order.

<!-- screenshot: the Matrix tab showing "Open a matrix" with the New matrix button -->

## Step 1 — Subjects: who is in it

First choose what one subject is:

| Choice | What it means | Use it for |
|---|---|---|
| **User accounts** | One subject per account. A person with three accounts appears three times. | Clean-up sweeps and per-account audits |
| **Identities** | One subject per person, across all their accounts. | Role mining and birthright analysis |

Then narrow down who is included. There are two lists, **Include** and **Exclude**, and each takes two kinds of condition:

- **+ Attribute** — pick a **Field** (department, for instance), then tick one or more values. Any of the ticked values matches. Long value lists show only the first part; use **Search values** to find the rest.
- **+ Context** — pick a [context](contexts.md) from the tree: a department, a manager's team, a group somebody uploaded. The condition appears as a chip with **incl. descendants** ticked, so everything below that context counts too. Untick it to keep only the direct members.

How the conditions combine:

- Two **Include** conditions must *both* match. A department condition plus a context for one manager's team gives you the people who are in both, not the two groups added together.
- Anything that matches an **Exclude** condition is taken out again.
- With nothing under **Include**, everybody is in.

Switching between **User accounts** and **Identities** clears the conditions on this step, because the two have different fields. Choose first, then narrow.

<!-- screenshot: the Subjects step with one attribute condition and one context chip under Include -->

## Step 2 — Resources: what access

Again a choice first:

- **Resources** — groups, roles, apps and sites. Business roles are shown as columns of their own, not as rows.
- **Resources and business roles** — each business role also gets a foldable row, with the resources it grants underneath it.

Then the same **Include** and **Exclude** lists, now for resources. **+ Attribute** offers the resource fields; **+ Context** offers resource contexts and systems, so "everything in this one system" is a single condition.

Under **More options** sits **Include inherited access**. Tick it to also show access that comes down from a higher scope — an Owner assignment on an Azure subscription then appears as an **Indirect** assignment on every resource beneath it. It is slower, and only meaningful once you have narrowed the resources.

<!-- screenshot: the Resources step with the two choices and the Include / Exclude lists -->

## The live counts

Under every step runs one line, for example:

> **45** of 1,200 users · 4% × **39** of 860 resources · 5% · **127** assignments

It updates as you add and remove conditions. Read it as: how many subjects and resources your conditions select out of everything there is, and how many assignments connect them. The last number is the size of the matrix, and it decides what happens next:

| Assignments | What the line says | What it means |
|---|---|---|
| Up to 5,000 | Nothing extra | Loads as a normal grid, one column per subject. |
| More than 5,000 | **large, consider narrowing** | Still loads as a normal grid. Narrow it if you can. |
| More than 5,000, grouped | **aggregated on the server, loads at any size** | The matrix opens folded, sorted by Manager Hierarchy or rolled up, so it shows counts per group. |
| More than 25,000, not grouped | **too large to load as a per-subject grid** | The button on the last step is disabled. |

A matrix of more than 25,000 assignments is only blocked when it would have to show every subject as its own column. Left on its defaults it opens folded into groups and loads fine. If you do get the red message, either add conditions until you are under 25,000, or go to **Layout** and let the matrix group itself: tick **Open with the first group folded into count columns**, sort **By Manager Hierarchy**, or switch **Roll up** on.

## Step 3 — Layout: how it reads

By default the resources are the rows and the subjects are the columns — the wizard says so in the headings **Columns are** and **Rows are** on the first two steps. The wizard does not offer to swap them.

**Group & sort columns** sets the order of the subjects:

- **By attributes** — one to six levels (**Sort by**, **then by**), each **A→Z** or **Z→A**. A new matrix starts sorted by department. Each level becomes a header row above the columns; in the matrix you click a header value to fold that group into a single count column.
- **By Manager Hierarchy** — orders subjects by their place in the reporting tree. This needs a Manager Hierarchy context; if none exists the step tells you so.
- **Open with the first group folded into count columns** — set to automatic for a new matrix: on from 5,000 assignments, off below.

**Roll up** replaces the individual subjects by groups, and each cell counts the subjects in the group who hold the access:

- **Off**, **By attribute** or **By context**.
- **Roll-up content** — **Resources and business roles**, **Resources only**, or **Business roles only**. The last one puts business roles on the rows and removes the **Resources** step from the wizard.
- **Cell value** — **Count (#)** or **Percentage (%)**.

While a roll-up is on, grouping and sorting are greyed out: the roll-up groups *are* the columns.

**Open with** decides what the matrix shows when it opens:

- **Show trends & breakdown above the matrix** — adds the [scope statistics](../architecture/matrix-scope-statistics.md) panel. Off by default.
- **Default lens** — **All**, **Governed**, **Non-governed** or **Gaps**. Anyone viewing the matrix can still switch lens; see [Reading the Matrix](../architecture/matrix.md).

<!-- screenshot: the Layout step showing Group & sort columns, Roll up and Open with -->

## Step 4 — Save & share: keep it, or just look

The last step has one field that matters: **Name**.

- **Leave it empty** and the button reads **Show matrix**. The matrix opens; nothing is stored. Good for a quick look.
- **Type a name** and the button reads **Save & show**. The matrix is saved and then opens. Saved matrices are visible to everyone in your organisation, and names are unique — a name that is taken comes back as an error.

**Add a description** is optional; it appears as a tooltip in the list of saved matrices.

If matrix sharing is switched on and your role allows it, a **Share with** section sits below the name. That is its own subject: see [Sharing a Matrix](sharing-a-matrix.md).

<!-- screenshot: the Save & share step with a name filled in and the Save & show button -->

## Reopen and adjust

A matrix that is on screen has a strip above it: its name on the left (or **Unsaved matrix**), its counts and **Adjust** on the right.

- **Reopen a saved matrix** — pick it from **Open a matrix**, or click the name in the strip and choose another from the menu.
- **Change it** — click **Adjust**. The same wizard opens as **Adjust matrix**, filled in with the current choices. Jump straight to the step you want to change.
- **Save the change** — when a saved matrix has been changed, the strip shows **Unsaved changes**. Click it to land on the last step, where the button now reads **Save changes & show**. To keep the original as it was, choose **Save as a copy instead** and give the copy its own name.
- **Rename, duplicate, see who changed it, delete** — **Rename…**, **Duplicate…**, **History…** and **Delete…** are in the name menu. Deleting affects everyone, and the app asks first.

Showing a matrix and saving it are separate acts. Adjusting a saved matrix and clicking **Show matrix** changes what is on your screen, not what is stored.

## If it does not look right

| What you see | Likely cause | What to do |
|---|---|---|
| **No data available yet** | Nothing has been imported. | Run a crawler, or load the demo data. |
| The counts say **0** of … subjects or resources | Your **Include** conditions contradict each other — all of them must match. | Remove one, or put several values in a single **+ Attribute** condition. |
| Subjects and resources are found, but **0 assignments** | These people hold none of these resources. | Widen one side. |
| Far too many columns | Too many subjects for a grid. | Narrow the subjects, fold the groups, or use **Roll up**. |
| Business roles are missing from the rows | They are shown as columns unless you ask for rows. | Choose **Resources and business roles** on the **Resources** step. |
| The context you want is not in the picker | Each side offers only contexts that fit it: account or identity contexts for subjects, resource contexts and systems for resources. | Check you are on the right step, and on the right choice of **User accounts** or **Identities**. |
| A value is missing from an attribute's list | Long lists show only the first part. | Type in **Search values**. |
| The last button is greyed out | The matrix is too large to load ungrouped. | See [The live counts](#the-live-counts). |

## Where next

- **[Reading the Matrix](../architecture/matrix.md)** — what the badges, folds and columns mean once it is open.
- **[Sharing a Matrix](sharing-a-matrix.md)** — send a saved matrix to a manager or an application owner.
- **[Contexts](contexts.md)** — build the groupings you filter and roll up by.
