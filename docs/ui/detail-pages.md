---
type: task
prereq: ui/reading-the-matrix.md
outcome: You can open the detail page of any account, identity, resource or business role and find its attributes, what it is connected to, how it changed, and how its risk score was reached.
---

# Reading a detail page

!!! info "Before this page"
    Assumes you have read **[Reading the matrix](reading-the-matrix.md)**.
    Brand new? Start at [The words you need first](../start/glossary.md).

The matrix tells you *that* an account holds a resource. A detail page tells you everything
else about one thing: who this account is, who is in this group, what this business role
grants, and what changed last month. Accounts, identities, resources and business roles each
have a detail page, and all four are built the same way, so learning one teaches you the rest.

<!-- screenshot: an account's detail page on the Relationships tab, with the tab bar showing Attributes, Relationships, Timeline, Diff and Risk -->

---

## Opening a detail page

A detail page opens as its own tab in the top navigation, next to **Matrix**, **Resources** and
the others. You can keep several open and switch between them. Close one with the **×** on its
tab or in the page's top-right corner.

**From the matrix:**

| Click | Opens |
|---|---|
| A resource's name at the start of a row | The resource |
| An account's name in a column header | The account |
| An identity's name in a column header (in a matrix of identities) | The identity |
| A business role's name in the header of its coloured column | The business role |
| A **BR** chip next to a resource name | The other business role that grants that resource |

**From the lists:** click a name on the **Principals (Users)**, **Resources**, **Business
Roles** or **Identities** tab.

**From another detail page:** every name that appears as a link (an owner, a member, a group,
a linked account) opens that item's own detail page.

---

## What every detail page has

### The header

The top of the page says what you are looking at: the name, a badge for its kind, and the few
facts you most often need. What those facts are differs per kind and is described
[further down](#what-differs-per-kind). An item that no longer exists in the system it came
from carries a **Deleted in source** badge.

### The tabs

| Tab | The question it answers |
|---|---|
| **Attributes** | What do we know about this item? |
| **Relationships** | What is it connected to: who holds it, what does it hold, who owns it? |
| **Timeline** | What changed, and when? |
| **Diff** | What is different now compared with a date in the past? |
| **Risk** | How risky is it, and why? |

The **Risk** tab is only there when risk scoring is switched on and the item has a score.

### Attributes

One table with every attribute Identity Atlas holds for the item, as *name | value*. The number
on the tab is how many attributes there are. Attributes that are specific to the source system
carry a small **ext** tag; they are just as real as the others, the tag only tells you they are
not part of the common set every system has.

Facts already shown in the header (such as the name and the description) are not repeated in
the table.

### Relationships

A diagram with the item in the middle and one circle around it for every kind of connection.
The number in a circle is how many there are; a circle with **0** is greyed out.

- **Click a circle** to fan it out into the individual items. The same items appear as a list
  under the diagram, each one a link to its own detail page.
- **Click an item** in the diagram to fan out *its* connections in turn. This way you can walk
  from an account to a business role to the resources that role grants without leaving the page.
- **Click the same circle again**, or **collapse** under the diagram, to fold it back.
- Drag to move the diagram, scroll to zoom.
- When a circle holds more items than fit in the diagram, the last one reads **+N more in the
  list below**. The list is always complete.
- **Export CSV** above the list downloads it.

### Timeline

A line with one dot per day on which something changed, oldest on the left. Click a dot to list
that day's changes; the most recent day is selected when you open the tab. Choose how far back
to look with **30 days**, **90 days**, **1 year** or **All**. The tab opens on 90 days.

Use it to answer "when did this account get that group?" or "who was added to this role last
week?". Names in the list are links.

Changes are recorded from the moment Identity Atlas first read the item. What happened in the
source system before that is not on the timeline.

### Diff

Timeline lists events; Diff shows the result. Pick a moment under **Compare with an earlier
moment** (**1 day ago**, **1 week ago**, **30 days ago**, **90 days ago**, **1 year ago**, or a
date of your own) and the page puts the item as it was then on the left and as it is **Now** on
the right: every attribute and every relationship, line by line.

- The chips at the top count what **changed**, was **added**, was **removed** and stayed
  **unchanged**.
- **Only show differences** hides the unchanged lines.
- A note appears above the comparison when it cannot tell the whole story, for example when
  the moment you picked lies before the start of the recorded change history, or when the item
  did not exist yet.

### Risk

The **Risk Assessment** panel shows the item's tier, its score from 0 to 100, and when it was
scored. Underneath are the four parts the score is built from, each with its own score and its
weight in the total:

| Part | Weight |
|---|---|
| **Classifier Match** | 50% |
| **Membership Analysis** | 20% |
| **Structural / Hygiene** | 10% |
| **Risk Propagation** | 20% |

**Show Details** opens the reasoning: which classifiers matched and why (**Classifier
Matches**), and the **Score Explanation**.

#### Overriding a score

If you know something the score does not, adjust it:

1. Click **Adjust Score** (or **Edit Override** when there already is one).
2. Move the **Score Adjustment** slider, from −50 (lower risk) to +50 (higher risk). The panel
   shows the resulting score.
3. Fill in **Reason**. It is required.
4. Click **Save Override**.

The adjustment is shown next to the score from then on, and the reason is listed under **Show
Details**, so the next reader can see that a person changed the score and why. **Remove
Override** returns the item to its calculated score.

For what the tiers mean and how a score is calculated, see
[How Scoring Works](../risk-scoring/overview.md).

---

## What differs per kind

### An account

<!-- screenshot: account header with type badge, system, job title, department, last sign-in and the Compare with… button -->

**Header:** name, the account's type (for example Member, Guest or
ServicePrincipal), its sign-in name or e-mail address, the **System** it lives in, job title,
department and company, the **Last sign-in** when one is known, and any tags.

**Attributes** also has an **Activity** section below the table: the account's most recent
sign-ins, with the date each figure was measured. It says **No activity recorded** when the
source system supplied none.

**Relationships** circles:

| Circle | Contains |
|---|---|
| **Manager**, **Direct Reports** | The account's place in the reporting line |
| **Contexts** | The contexts the account is a member of |
| **Direct**, **Indirect**, **Eligible** | Everything the account holds, split by how it is held: the same three ways as the matrix badges. The list shows the type of each resource, so group memberships, ownerships, application roles and permissions are all here. |
| **Business Roles** | The business roles the account holds |
| **Identity** | The person this account belongs to |

A few more circles appear only when they apply: **Owned Resources** (resources this account is
the owner of), **Owners** and **Sponsors** (who answers for this account, for example for an
AI agent or a guest), and the reverse of those, **Owned Agents** and **Sponsored Guests**.

**Compare with…** in the header puts this account next to one or two others; see
[Comparing accounts](#comparing-accounts).

### A resource

**Header:** name, the type of resource (Group, AppRole, and so on), the system it comes from,
its description, and any tags.

The header also names the **Owner** (or **Owners**) when one is known. An owner that Identity
Atlas holds an account for is a link to that account. An owner that only the source system
knows by name is shown as plain text. Hover the name to see how the owner is known.

**Relationships** circles:

| Circle | Contains |
|---|---|
| **Direct Members**, **Indirect Members**, **Eligible** | The accounts that hold this resource, split by how |
| **Business Roles** | The business roles that grant this resource |
| **Member Of** | The resources this one is itself a member of, such as a group inside another group |
| **Contexts** | The contexts the resource belongs to |
| **Owners** | Who answers for the resource. Only shown when there is an owner. |

This is the page for "who can access this, and why?".
[Effective Access](effective-access.md) walks through that question step by step.

### A business role

<!-- screenshot: business role Attributes tab with the Overview panel and the Assignment Policies, Access Reviews and Pending Requests sections -->

**Header:** name, the catalog the role belongs to, its description, its category, and the date
and reviewer of the **Last Certification** when there has been one.

**Attributes** has more on it than for the other kinds:

- **Overview**, above the table: the role's type, its **Review status**, the **Review date**
  and **Reviewed by**, and its category.
- Below the table: **Assignment Policies**, **Access Reviews** and **Pending Requests**, each with
  a count.

**Relationships** circles:

| Circle | Contains |
|---|---|
| **Assignments** | The accounts that hold the role |
| **Resources** | The resources the role grants |
| **Catalog** | The catalog the role is part of |

### An identity

**Header:** the person's name, how many accounts they have, the context they belong to (a
link), and their job title when the HR source supplies one.

An identity holds no access itself; its accounts do. So the diagram is small: **Linked
Accounts** and **Contexts**. To see what the person can do, click an account under **Linked
Accounts** and fan out that account's own circles.

Below the diagram, the **Linked Accounts** table lists every account of this person: **System**,
**Account**, **Enabled** and **Type**. The last column says where the link comes from:

- **Linked from source**: the source system itself says this account belongs to this person.
- **Confirm** and **Remove**: Identity Atlas matched the account to the person. Confirm the
  match if it is right, remove it if it is not. **Undo** takes your decision back.

How accounts are matched to people is explained in
[One Person, Many Accounts](../architecture/account-linking.md).

### A context

A context has a page of its own with a different layout. See [Contexts](contexts.md).

---

## Comparing accounts

Diff compares one item at two moments. **Compare** puts two or three accounts side by side as
they are now, to answer "these two people do the same job, so where does their access differ?".

Open it in either of two ways:

- **Compare with…** in an account's header, then add one or two more accounts.
- On the **Principals (Users)** tab, select two or three rows and click **Compare**.

The page shows one column per account. **Only show differences** is on to begin with, so you
start with just the lines where the accounts differ. Names, e-mail addresses and IDs are
hidden as well, because they differ between any two accounts.

---

## When you arrive through a shared matrix

Someone who opens a [shared matrix](sharing-a-matrix.md) and clicks a name sees a reduced
detail page: the **Attributes** and **Relationships** tabs only, with nothing to change.
Timeline, Diff and Risk are for analysts.

---

## Related

- [Reading the matrix](reading-the-matrix.md): where most detail pages are opened from.
- [Effective Access](effective-access.md): use a resource's detail page to answer "who can
  access this, and why?".
- [How Scoring Works](../risk-scoring/overview.md): what is behind the Risk tab.
- [Audit History](../architecture/audit-history.md): where the Timeline and Diff get their
  data.
