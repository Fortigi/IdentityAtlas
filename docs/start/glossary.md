---
type: start
prereq: none
outcome: You can read any other page here without stopping to look up a word.
---

# The words you need first

Identity Atlas talks about identities, accounts, resources and assignments. Four words, and if you have never worked in identity and access management, none of them mean quite what you would guess — and if you *have*, at least one of them means something different here than in the platform you came from.

This page is the vocabulary, **in the order you need it** — not alphabetically. Read it top to bottom once and the rest of the documentation stops being a foreign language. It takes about eight minutes.

If you already know IAM, skim it anyway: a couple of these words mean something narrower here than they do in your last product.

!!! tip "Keep it open"
    Nothing on this page is worth memorising. It is worth knowing *where it is*. There is an [A–Z index](#az-index) at the bottom for when you arrive here from a search.

---

## 1. System

**A place permissions live.** Entra ID is a system. So is an Azure subscription, an SAP landscape, a SharePoint tenant, an Omada Identity installation, a CSV export from SailPoint.

How Identity Atlas *reaches* a system varies — some have a dedicated crawler (Entra ID, Azure Resource Manager, Omada, midPoint), others arrive by [CSV import](../sync/csv-import.md) or the [ingest API](../architecture/ingest-api.md). That is a connection detail. Either way it is a system, and everything below hangs off one.

Identity Atlas does not replace your systems and does not write to them. It reads them and puts what it finds side by side.

> Everything below belongs to exactly one system. That is the whole reason the rest of the model can stay simple.

## 2. Account — which this product calls a *principal*

**A login that exists inside one system.** `piet.jansen@fortigidemo.com` in Entra ID is one account. Piet's SAP user is a *different* account. So is the service account that runs your deployment pipeline.

**Account** is the word most systems use, and it is the one to keep in your head. **Principal** is what *Identity Atlas* calls the same thing — it is the name of the table the data lands in, and you will see it throughout the UI and the API. The two are interchangeable when you read this documentation.

Why a different word at all? Because "account" makes people picture a human, and most of them are not:

| The account / principal is a… | Example |
|---|---|
| Person | An employee's Entra user |
| Service principal | An app registration that calls an API |
| Managed identity | An Azure workload that authenticates without a secret |
| AI agent | A Copilot Studio agent acting on someone's behalf |

!!! note "If you come from Entra ID"
    Entra also uses "principal" (in *service principal*, *security principal*). Identity Atlas means something slightly broader: **any** account in **any** connected system, Entra or not. An SAP user is a principal here; in Entra's vocabulary it would not be.

**The trap:** an account is not a person. One person usually has several. That is the next word's entire job.

## 3. Identity

**The actual human being (or the actual robot), stitched together from their accounts.**

Piet has an Entra account, an SAP account and an Azure account. Those are three accounts — three principals — and one **identity**. Identity Atlas links them for you; the process is called [account linking](../architecture/account-linking.md).

Why bother? Because every interesting question is asked about the *person*, not the login:

- *"What can Piet actually do?"* — not answerable from any single system.
- *"Which department has the most SAP users?"* — an SAP account list does not record a department. The identity does.

> **Identity = who.** **Account (principal) = which login.** If you only remember one distinction from this page, make it this one.

## 4. Resource

**Anything that grants access.** A group, a role, a SharePoint site, an application permission, an Azure role assignment.

This is broader than it sounds, and deliberately so. Identity Atlas stores an Entra security group and an SAP role in the same table, with the same shape, because the question *"who holds this, and how?"* is the same question either way. What kind of thing it is lives in a field called `resourceType`.

!!! warning "This word does not travel well"
    "Resource" is one of the most overloaded words in identity management, and your platform almost certainly uses it to mean something else. Read this row before you map anything:

    | If you come from… | *There*, "resource" means | *Here*, that thing is a… |
    |---|---|---|
    | **midPoint** | `ResourceType` — a connected system with accounts in it (AD, an HR database, a CSV feed) | **System** — see [§1](#1-system). **Not** a resource. This is the one that catches people. |
    | **Omada** | very broad — a `Resource` object covers permissions, entitlements and more | **Resource**, mostly. Omada's `ROLECATEGORY` decides the exact `resourceType`; see [Omada Data Model Reference](../architecture/omada-crawler-datamodel.md) |
    | **Azure Resource Manager** | a deployed thing — a VM, a storage account, a resource group | **Resource** — and the RBAC role assignment on it is the [assignment](#5-assignment) |
    | **Entra ID** | not really Entra's word; it says group, role, app role | **Resource** — all of those are resources here |

    In Identity Atlas the test is single and mechanical: **if holding it gives someone access, it is a resource.** If it is the place the access lives, it is a system.

## 5. Assignment

**The link: this account holds this resource.**

An assignment is the atom of the whole product. Everything else — the matrix, risk scoring, access reviews — is a way of looking at a pile of assignments.

Both halves are the words you just met: the account from [§2](#2-account-which-this-product-calls-a-principal), the resource from [§4](#4-resource) — in *this* product's sense of "resource", not your platform's. In the database the row is a `ResourceAssignment` and it names a `principalId` and a `resourceId`.

Every assignment records not just *that* someone has access, but **how**:

| How | What it means | Where it comes from |
|---|---|---|
| **Direct** | Granted to them, personally | Someone added them to the group |
| **Indirect** | Inherited through something else | The group is inside a role they hold |
| **Eligible** | They can switch it on, but haven't | PIM eligibility — a real risk that most exports miss entirely |

Those three are the *only* values. Older versions of Identity Atlas had ten; they collapsed into these three, with the flavour moved to `resourceType`. If you meet an `Owner` or `Governed` assignment type in an old document, it is out of date — see [Data Model](../concepts/data-model.md).

**Why "Eligible" matters:** an eligible assignment is access nobody currently has and everybody forgets to review. It is the single most common thing a raw export gets wrong.

## 6. Group and role — the difference people get wrong

Both are resources. Both grant access. They are not the same idea.

- A **group** is a bag of members. It exists in the source system and usually grew organically.
- A **business role** is a *deliberate* bundle: "everyone in Sales should have these five things." It is the intent, written down.

The distance between the two is the product's reason to exist. Somebody has access. Is it because a role says they should — or because someone added them in 2019 and nobody noticed?

> Identity Atlas marks that difference with a flag called **`governed`** on the assignment. Governed means: a role or an access package granted this, on purpose. Ungoverned means: it is just… there.
>
> You may see this called **SOLL vs IST** — German for *should-be* versus *is*. Same idea.

## 7. Ownership

**Who is responsible for a resource** — not who can use it.

Owning a group is itself a form of access: an owner can usually add members, which means an owner can grant themselves anything the group grants. Identity Atlas therefore models ownership as a resource in its own right rather than as a footnote, so it shows up in the matrix like any other access.

## 8. Crawler and sync

**A crawler is the thing that goes and fetches.** One per source system: Entra ID, Azure Resource Manager, Omada, midPoint. Anything without a crawler comes in by [CSV import](../sync/csv-import.md) or the [ingest API](../architecture/ingest-api.md).

A **sync** is one run of a crawler. Runs are versioned, so you can ask what access looked like last quarter — see [Audit History](../architecture/audit-history.md).

## 9. The matrix

**The main screen.** A grid: people down the side, resources across the top. Each cell says *how* that person holds that access — not merely that they do.

You never look at all of it at once. You choose who and what is in the grid; that choice is called the **scope**.

Reading a matrix cell is a skill, and it is the one that unlocks everything else. [Your first 15 minutes](first-15-minutes.md) teaches it on real data.

## 10. Scope

**The filter that decides which rows and columns you are looking at.** "The Sales department against every resource they hold." "Every account with a never-expiring password, against risky app consents."

A scope is a question, expressed as a grid. Saving a scope saves the question.

## 11. Context

**A named grouping of things, used to scope, compare and organise.** Departments. Manager hierarchies. Azure scope trees. Risky OAuth consents. Tags.

Contexts come in three flavours, and this is the bit that confuses people:

| Flavour | Where it comes from |
|---|---|
| **Synced** | Read from a source system (an Entra group category, an AD OU) |
| **Generated** | Produced by a **plugin** — an algorithm that derives a grouping from the data you already have |
| **Manual** | You made it by hand |

A context always targets exactly one kind of thing: an **Identity**, a **Resource**, a **Principal** or a **System**.

**Plugins** are the interesting half. Ten ship in the box — including manager hierarchies, department trees, orphaned accounts and risky-consent grouping. A plugin does not import anything; it finds structure that was already there and gives it a name you can filter on. See [Contexts](../ui/contexts.md).

## 12. Effective access

**What someone can actually do, once every inheritance hop is followed.**

Declared access is what a single record says. Effective access is the answer after you have walked nested groups, role bundles and Azure scope inheritance to the end. They are frequently not the same number, and the difference is usually where the unpleasant surprise lives.

## 13. Risk score and tier

Every identity gets a number from 0 to 100 and a tier. The cutoffs are fixed:

| Score | Tier |
|---|---|
| 90–100 | **Critical** |
| 70–89 | **High** |
| 40–69 | **Medium** |
| 20–39 | **Low** |
| 1–19 | **Minimal** |
| 0 | **None** |

The score is explainable — you can always open it and see which factors produced it — and an analyst can override it with a written reason. Nothing about your identity data is sent anywhere to compute it. See [Risk scoring](../risk-scoring/overview.md).

---

## Now go and use it

You have the vocabulary. The fastest way to make it stick is to use it on data that is already loaded:

- **[Your first 15 minutes](first-15-minutes.md)** — find one real finding, guided, click by click.
- **[Capture the Flag](../demo/capture-the-flag.md)** — twelve questions, easy to hard. Read [Before you play](../demo/before-you-play.md) first if any of the words above are still slippery.

---

## A–Z index

For when you arrived here from a search box.

| Term | Section |
|---|---|
| Account | [Account (principal)](#2-account-which-this-product-calls-a-principal) |
| AI agent | [Account (principal)](#2-account-which-this-product-calls-a-principal) |
| Assignment | [Assignment](#5-assignment) |
| Business role | [Group and role](#6-group-and-role-the-difference-people-get-wrong) |
| Context | [Context](#11-context) |
| Crawler | [Crawler and sync](#8-crawler-and-sync) |
| Direct | [Assignment](#5-assignment) |
| Effective access | [Effective access](#12-effective-access) |
| Eligible | [Assignment](#5-assignment) |
| Generated context | [Context](#11-context) |
| Governed | [Group and role](#6-group-and-role-the-difference-people-get-wrong) |
| Group | [Group and role](#6-group-and-role-the-difference-people-get-wrong) |
| Identity | [Identity](#3-identity) |
| Indirect | [Assignment](#5-assignment) |
| IST / SOLL | [Group and role](#6-group-and-role-the-difference-people-get-wrong) |
| Managed identity | [Account (principal)](#2-account-which-this-product-calls-a-principal) |
| Matrix | [The matrix](#9-the-matrix) |
| Ownership | [Ownership](#7-ownership) |
| Plugin | [Context](#11-context) |
| Principal | [Account (principal)](#2-account-which-this-product-calls-a-principal) |
| Resource | [Resource](#4-resource) |
| Risk tier | [Risk score and tier](#13-risk-score-and-tier) |
| Scope | [Scope](#10-scope) |
| Service principal | [Account (principal)](#2-account-which-this-product-calls-a-principal) |
| Sync | [Crawler and sync](#8-crawler-and-sync) |
| System | [System](#1-system) |
