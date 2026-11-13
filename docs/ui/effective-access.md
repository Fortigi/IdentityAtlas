---
type: task
prereq: start/glossary.md
outcome: You can list who holds a resource, tell direct from inherited and eligible access, and find the route an inherited holder took.
---

# Answer: who can access resource X, and why

!!! info "Before this page"
    Assumes you have read **[The words you need first](../start/glossary.md)**, in particular
    [resource](../start/glossary.md#4-resource), [assignment](../start/glossary.md#5-assignment) and
    [effective access](../start/glossary.md#12-effective-access).

A task guide for the recurring question: **"Who can reach this resource, and how did they get it?"**
You answer the *who* on the resource's own page and the *why* in the matrix.

---

## 1. Open the resource

1. Go to the **Resources** tab and search for the resource by name.
2. Click its name. The resource opens in its own detail tab.

The header shows the resource's type, the system it comes from, its description and, when the source
names one, its **Owner**. An owner Identity Atlas holds an account for is a link to that account.

Below the header are the tabs **Attributes**, **Relationships**, **Timeline** and **Diff**. A **Risk**
tab is added when risk scoring is switched on and the resource has a score.

<!-- screenshot: a resource detail tab on the Relationships tab, with the Direct Members node fanned out -->

---

## 2. List who holds it

Open the **Relationships** tab. The graph puts the resource in the middle and one node per kind of
relationship around it, each with a count:

| Node | Who or what is in it |
|------|----------------------|
| **Direct Members** | Accounts assigned to the resource itself |
| **Indirect Members** | Accounts that hold it through something else, such as a nested group |
| **Eligible** | Accounts that can switch the access on but do not hold it right now |
| **Business Roles** | The business roles that grant this resource |
| **Member Of** | The resources this one is itself a member of |
| **Contexts** | The contexts this resource belongs to |
| **Owners** | Who answers for the resource (shown only when there is an owner) |

Click a node to fan it out. The list under the graph shows what is in it:

- Click a name to open that account, business role or context.
- Sort the list on **Name** or **Type**.
- **Export CSV** downloads the list as it is on screen.
- Accounts that used to hold the resource but are gone from the source are kept apart, behind
  **Show … historical (no longer in the source)**.

Click the node again, or **collapse**, to close the list.

For a review, read the three member nodes separately:

- **Direct Members** is the shortest answer to "who has it": somebody granted it to these accounts by name.
- **Indirect Members** inherited it. Nobody added them to this resource; they hold it because of
  something else they are in.
- **Eligible** is **not** current access. Keep it out of a "who can touch this today" count, and keep
  it in a "who could" count.

!!! note "Owners are not members"
    Owning a group is a form of access of its own, so it is not mixed into the member lists. The
    **Owners** node and the header name the owner; in the matrix, ownership of a group is a row of its
    own, on which each owner has a `D`.

---

## 3. Find the route — the "why"

The **Indirect Members** list tells you *who* inherited the resource, not *through what*. The route is
visible in three places.

**Which business roles hand it out.** The **Business Roles** node on the resource's page lists every
business role that grants this resource. Access that comes with one of those roles is there on purpose.

**Which group carries it.** Open a matrix that contains the resource and the groups the account is in
(see below). A group that is itself a member of other groups, or that has app roles assigned to it,
shows a chevron in front of its name. Click it (**Expand nested groups**) and whatever that group is a
member of appears as rows under it. Find the group the account holds with a `D`, expand it, and look
for your resource beneath it: the account reaches the resource through that group.

**Which higher scope grants it.** This applies to resources that sit in a hierarchy, such as Azure
subscriptions and resource groups. In the matrix wizard, on the **Resources** step, open
**More options** and tick **Include inherited access**. Inherited grants then show as `I`, and clicking
such an `I` opens **How this inherited access arose**: the role that was granted, where it was granted,
and the chain from there down to the resource.

### Getting to a matrix that contains the resource

The resource page has no button that opens a matrix. There are two ways to get one:

- **Through a context.** Fan out the **Contexts** node on the resource's page and open a context the
  resource belongs to. On an organisation unit or an application, the **⋯** menu in the context's
  header has **View in matrix ↗**, which opens a matrix of that context's resources in a new browser tab.
- **By building one.** On the **Matrix** tab choose **New matrix**. On the **Resources** step, under
  **Include**, click **+ Attribute**, pick the field that holds the resource's name, and tick the
  resource. Or click **+ Context** and pick a context the resource belongs to. Finish the wizard to show
  the matrix.

Use the **?** button in the top-left corner of the grid (**How to read this matrix**) for the meaning
of every badge and marker.

---

## Putting it together

A complete answer to "who can access resource X, and why" reads like this:

> *These accounts hold it **directly**. These others hold it **indirectly**: through this group they
> are a member of, or through a grant higher in the hierarchy. These are **eligible** only and hold nothing right now.
> These business roles hand it out, and this is the owner.*

---

## Scripting the same question

The API answers the same question for one account at a time, including the capabilities that account
effectively holds on the resource. See [Effective Access](../api/matrix.md#effective-access) in the API
reference.
