---
type: task
prereq: ui/contexts.md
outcome: You can run the Entitlement Pivot over any context of resources or unit of accounts, choose its columns and its Excel pivots, and save that setup as a view your colleagues can open from the Reports page.
---

# Entitlement Pivot and saved views

The **Entitlement Pivot** report (formerly *Application Access Review*) lists every resource of one or
more contexts: a logical application synced from a catalogue, a department's file shares, everything tagged *PCI*. Any context whose members
are resources works, and so does any resource type (groups, app roles, entitlements). For each
resource it shows:

- which business roles grant it (*Granted by role(s)*),
- how many people hold it **directly**,
- how many hold it **through a role**.

That split decides what an owner has to review. When a role grants an entitlement, the role's policy
manages who holds it. An entitlement with a single direct holder is usually an admin or a service
account.

Above the table the report summarises the scope: unique users, number of entitlements, how many have
an owner, and the share that is part of a business role.

## On a unit of accounts

A **unit of accounts** (for example a department of Entra accounts) works too. The report then lists
the resources the unit's **direct members** hold, and the counts only count those members: "3 of
this department hold it", not everyone in the company. A resource that only people outside the unit
hold is not in the list, and neither are business roles (they show in *Granted by role(s)*). Accounts
in sub-units are not included; add the sub-units to the run to review them as well. A run cannot mix
units of accounts with contexts of resources, because the counts would mean different things; the
report says so instead.

Run it on a unit from the **Reports** page (pick the unit under contexts). The **Actions › Download
entitlement report** card is on application pages only; a unit's page offers **View in matrix**.

## Choosing the columns

Under **Columns**, pick what to show between the entitlement and its counts. The list offers:

- **Built-in fields** every deployment has: the context's name, type, description and owner; the
  resource's type, system, description, owner, owner employee ID and owner email; the number of
  *eligible* holders.
- **Attributes** the source systems stored on the contexts you picked, or on their resources. Examples
  are a CMDB reference from an application catalogue, or a certification frequency or cost centre from
  IdentityIQ. Only attributes the picked contexts actually carry are offered, and each says how many
  resources have a value for it (*on 38,201 of 39,072 resources*).

Pick the contexts first: the attribute list follows them. If none of the rows has a value for an
attribute you picked, the report says so above the table.

You do not have to pick the entitlements' own attributes to see them: after the counts, the report adds
a column for **every attribute the entitlements in the report carry** (for example *certfrequency* or
*requestable* from IdentityIQ), sorted by name and headed by the attribute's name. At most 60 are
added; if there are more, the ones most entitlements carry are kept and the rest are named on the
Summary tab, so you can pick them.

**The owner** comes in three columns: name, employee ID and e-mail — the default columns include all
three. It is the owner linked to the entitlement; when there is none but the source named an owner
(`ownerId` / `ownerName`, which the IdentityIQ preset stores), the report looks that person up by
account key, then by employee ID, and otherwise shows the name the source gave.

## The Excel pivots

**Download XLSX** opens on a *Summary* tab, then *Data* (the table), then two ready-made pivot tables:

| Pivot | Broken down by | Filters |
|---|---|---|
| *Direct assignments* | the **Pivot rows** you picked, then the entitlement | the **Pivot filters** you picked, plus *Users assigned via a role* (pick 0 for entitlements no role hands out) |
| *Assignments via roles* | the business role, then the entitlement | the **Pivot filters** you picked |

Any field can be a pivot row or filter, attributes included. A field you use in a pivot is added to the
table if you did not pick it as a column, because a pivot can only read what the table holds.

When the report covers **one** context, the context fields you picked are stated once on the Summary
tab instead of being repeated on every row.

The Summary tab also describes **each context in full**: who is Accountable and Responsible (name,
employee ID, e-mail) — or, when nobody is Accountable yet, the suggested person and why, as on the
context page — and every attribute the context page lists under *More details*.

## Saving your setup as a view

Choosing contexts, columns and pivots each time is tedious. **Save as view** stores them under a name:

1. Set the report up the way you want it on its tab. You can also start from scratch.
2. Choose **Save as view**. The wizard walks through **Scope**, **Columns** and **Excel pivots**,
   starting from what is on the tab.
3. Give the view a name and, optionally, a description, then **Save view**.

The view opens in its own tab and appears under **Saved views** on the Reports page for everyone who
can read data. It always runs on the latest data; only your choices are stored. You can still adjust a
view's settings on its tab for one run without changing the view.

To change a view, open it and choose **Edit view**. **Save changes** updates it for everyone, and
**Save as a new view** keeps the original. Delete a view from the Reports page.

Saving, changing and deleting views needs the **Build custom reports** permission
(`data.write.reports`). Unlike custom reports, views need no experimental feature.

Saved views work for every standard report that has settings, not only the Entitlement Pivot. For how it
works inside, see [Reports](../architecture/reports.md).
