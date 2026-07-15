# Answer: who can access resource X, and why

A task guide for the recurring analyst question: **"Who can reach this resource, and how did they get it?"** Identity Atlas answers it by resolving *effective* access — not just who is directly assigned, but everyone who inherits access through a group or a containing scope, together with the path that got them there.

This walkthrough uses the Resources page and the Matrix; the same data is available over the API via [`GET /api/resource/:id/effective-access`](../api/matrix.md#get-apiresourceideffective-access) if you want to script it.

---

## 1. Open resource X

Go to the **Resources** page, search for the resource by name, and click it to open its detail tab. The **Members** section lists everyone assigned to it, each with a membership badge:

| Badge | Meaning |
|-------|---------|
| `D` | Direct — assigned on the resource itself |
| `I` | Indirect — reached through a group or a containing scope |
| `E` | Eligible — can activate via PIM, but holds nothing right now |

!!! note
    Ownership is its own resource. If you are auditing *who owns* a group, look for the matching `Owner @ <group>` (`resourceType='GroupOwnership'`) resource — owners appear there as a normal `D` membership, not as a separate badge on the group.

---

## 2. List the direct and inherited holders

The Members list already separates the two cases by badge:

- **`D` (direct)** — these principals are assigned to resource X itself. This is the shortest answer to "who has it".
- **`I` (indirect)** — these principals inherited it. They do *not* appear on the resource by name in the raw assignment table; they hold it because they are a member of a group that is assigned, or sit under a scope that contains it.

Use the **membership type filter** on the Members section to show only `Direct` or only `Indirect` holders when you need to separate "explicitly granted" from "inherited" for a review.

!!! tip
    `E` (Eligible) is **not** current access. An eligible holder can activate through PIM but has nothing active right now — keep it out of a "who can touch this today" count.

---

## 3. Read the access path — the "why"

An `I` badge tells you access was inherited; the **expand affordance** tells you *through what*.

- **From the Matrix.** Rows are resources, columns are principals. Click the chevron on a group row to fan out its **nested parent groups** and **assigned app roles** — this shows which group a member is inheriting the resource through (their cell paints an `I`). See the [Matrix architecture](../architecture/matrix.md#expand-semantics) for the expand semantics.
- **From the API.** [`GET /api/resource/:id/effective-access?principalId=<id>`](../api/matrix.md#get-apiresourceideffective-access) returns, for one principal, every capability they effectively hold at the resource plus a `badge` of `Direct` / `Indirect` / `Eligible`. A `Direct` badge means the grant is declared on the resource itself and held without a group hop; anything reached through a group or a containing scope comes back `Indirect`. The response also carries a `truncated` flag — if it is non-null, an expansion hit its cap and the holder list is incomplete, so widen or re-scope before you treat the list as exhaustive.

Putting it together, a complete answer to "who can access resource X, and why" reads as:

> *These principals hold it **directly** (assigned on X). These others hold it **indirectly** — each through the group shown by the expand. These are **eligible** only and hold nothing right now.*

---

## Related

- [Matrix view — architecture](../architecture/matrix.md) — badge collapse rules and expand semantics
- [Matrix & Permissions API](../api/matrix.md#effective-access) — the effective-access endpoints
