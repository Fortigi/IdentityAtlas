---
type: start
prereq: demo/before-you-play.md
outcome: You have answered twelve questions that a raw export cannot answer.
---

# Capture the Flag

!!! info "Before this page"
    Assumes you have read **[Before you play](./before-you-play.md)**.
    Brand new? Start at [The words you need first](../start/glossary.md).

Twelve questions hidden in the demo data.

Every one of them is **painful to answer from a raw export** — a CSV out of Entra, an SAP account list, an Azure RBAC dump — and **straightforward once the same data is in Identity Atlas**. That is the whole point. The data isn't secret. The insight is the product.

You don't need an IAM background to start. The tracks build up: the first questions are a guided tour of one screen, the last ones ask you to combine three signals that live in three different places.

---

## House rules

- **Honour system.** There are no accounts and no tracking. Nothing stops you reading the answers — they're in this open-source repo. But if you look them up, you've only cheated yourself out of the thing that makes this worth doing.
- **Hints are free; answers cost you the flag.** Every question below has a hint telling you roughly where to look. Use them as much as you like. Looking up the actual answer scores nothing for that flag.
- **The demo resets every night.** Anything you change is wiped. Feel free to click, filter and break things.
- **The data is 100% synthetic.** Fortigi Demo Corp is not a real company, and none of these people exist.

!!! danger "Where not to look"
    [Demo Dataset](../architecture/demo-dataset.md) is the engineering reference for this dataset and it **contains the full answer key**. If you want to actually play, don't open it until you're done.

## How to enter

Email your twelve answers to **[flag@identityatlas.io](mailto:flag@identityatlas.io)**.

Score **90% or better (11 of 12)** and you get an invitation to the next Fortigi borrel. 🍻

## Before you start

Two things worth knowing, so you don't hunt for something that isn't switched on:

**1. Track 3 needs the Risky Consent plugin to have run.** It sorts the OAuth consent grants by how dangerous the permission is, into groups you can then scope a matrix to.

First check whether it's already done — on most demo environments it is. Go to **Contexts** and look in the left-hand **Trees** pane for a group called **RiskyConsent (Resource)**. If **Risky Consent — High** is listed, you're set; skip to Track 1.

If it isn't there, run it:

> **Contexts** → **+ New** (top of the Trees pane) → **Run a plugin** → **Next ▸** → pick **Risky Consent** (under the *Resource* heading) → **Next ▸** → **Next ▸** (the defaults are correct — leave the form alone) → **Create tree**

A preview runs by itself on the last step; the button that commits it says **Create tree**, not "Run".

!!! note "Admin → Plugins won't help you here"
    That tab lists context plugin trees that already exist, so it can re-run one — but it can't start the first run. New trees are only created from **Contexts → + New**.

**2. The access matrix is the main screen.** If you've never used it: it's a grid of subjects (people) against resources (what they can get at). You choose who's in the grid with a filter, and each cell tells you *how* that person holds that access — not just that they do.

---

## Track 1 — Access matrix & roles

Meet the Sales department. Seven questions, one screen, rising difficulty. This track teaches you to read the matrix: how to scope it, how to tell *direct* access from access someone gets *through a role*, and how to spot the difference between a good role-mining idea and a bad one.

### Flag 1 — Sales headcount *(Starter)*

> **How many identities does the Sales department have?**

!!! tip "Hint"
    Scope the matrix (or the Identities list) to the Sales department. Then count carefully — the first number the screen gives you is not necessarily the number the question is asking for.

### Flag 2 — The shared core *(Starter)*

> **How many resource assignments do all Sales users share?**

That is: how many resources does *every single member* of Sales have, without exception?

!!! tip "Hint"
    Scope the matrix to Sales and look down the columns for the resources where nobody is missing a cell. There is no one-click "shared by all" statistic yet — you're reading the grid by eye. (If that annoys you, good: it's a gap we know about.)

### Flag 3 — The outsiders *(Intermediate)*

> **Which two users *outside* Sales also have that exact shared set?**

!!! tip "Hint"
    Widen the scope past Sales and look for the same pattern of cells. Ask yourself how someone who doesn't work in Sales could end up looking exactly like someone who does.

### Flag 4 — Why does Piet have this? *(Intermediate)*

> **Piet Jansen can get into the CRM. What is the most likely reason?**

!!! tip "Hint"
    Find Piet's cell for the CRM group and look at what the badge is telling you. The matrix records *how* access is held, not just that it is — and it can show you where it came from.

### Flag 5 — Role or not? *(Intermediate)*

> **Of the assignments all Sales users share, which ones are granted by a role rather than held directly?**

!!! tip "Hint"
    The matrix can show you only governed access, or only non-governed. Flipping between the two answers this question faster than reading badges one by one.

### Flag 6 — The role candidate *(Advanced)*

> **Which resource assignment could probably be added to the Sales role?**

Role mining in one question: the Sales business role grants a certain set. Somewhere there's a group that *should* arguably be in it but isn't.

!!! tip "Hint"
    Look for something almost every Sales member has, but that the role doesn't grant them. "Almost" is doing real work in that sentence.

### Flag 7 — The trap *(Pro)*

> **Which resource assignment *looks* like it could be added to the role, but should not be — and why?**

Two things fit flag 6's pattern. Only one of them is a good idea.

!!! tip "Hint"
    Compare the two candidates: who else holds it, what it actually gives access to, and whether anyone ever signed off on it. One of them isn't Sales' to have. We want the resource **and** the reason.

---

## Track 2 — Cloud & accounts

Now leave Entra. This track is about the questions that get hard when a person has accounts in more than one system, and no two systems agree on what to call them.

### Flag 8 — SAP by department *(Intermediate)*

> **Which department has the most users in SAP ERP?**

!!! tip "Hint"
    Go and look at an SAP account. It won't tell you which department its owner is in — a real ERP account list never does. Something else in Identity Atlas already knows who that account belongs to.

### Flag 9 — Passwords that never expire *(Intermediate)*

> **Which accounts have passwords set to never expire?**

!!! tip "Hint"
    It isn't a column on the users list. But the crawler did bring the attribute along, and the matrix filter wizard can build a filter on attributes like that one — look for the ones prefixed `ext.`.

### Flag 10 — Azure US *(Intermediate)*

> **Which users have access to a resource in Azure US?**

!!! tip "Hint"
    Azure resources carry their region. Filter the resource side of the matrix on it rather than the people side. Careful: at least one person has access in more than one region, so "everyone who isn't in Europe" will not get you there.

---

## Track 3 — Apps & consent

Shadow IT. Somebody in Fortigi Demo Corp clicked "Accept" on a third-party app, and nobody reviewed it. These two are the payoff: questions a security team genuinely asks and genuinely struggles to answer.

### Flag 11 — Who consented? *(Advanced)*

> **Which users have consented to `Files.ReadWrite.All`?**

That permission lets an app read and write every file the user can reach.

!!! tip "Hint"
    The **Risky Consent — High** context (see *Before you start*) groups the dangerous consent grants for you. The permission itself is a resource — so once you've found it, the question turns into "who holds this resource?", which is exactly what the matrix is for.

### Flag 12 — The worst of both *(Pro)*

> **Which users consented to a *risky* app **and** have a never-expiring password?**

An account whose password never rotates, which has also handed a third-party app broad access to its files. That's the combination you'd want to know about on a Monday morning.

!!! tip "Hint"
    This is flags 9 and 11 on one screen: filter the resource side to the risky grants, and the subject side to the never-expiring accounts. Read the answer off the cells, not off the row count. And note the word *risky* is load-bearing — plenty of people have consented to something.

---

## When you're done

Send your twelve answers to **[flag@identityatlas.io](mailto:flag@identityatlas.io)**.

If you got stuck on one and want to know how it was *meant* to be found, that's a good sign — tell us which one. Half the reason this exists is to find out which questions Identity Atlas doesn't yet answer as well as it should.

---

## Answer key

Don't open this until you've had a go. Opening it scores you nothing — but marking your own paper afterwards is the point of the exercise, so it lives here rather than somewhere you'd have to go asking for it.

These are checked by CI on every change to the demo data, so they can't quietly drift out of date.

??? danger "Spoilers — the answers to all twelve"

    **Track 1 — Access matrix & roles**

    | # | Answer |
    |---|---|
    | **1** | **6** — David El-Amin, Paul Quinn, Rachel Smith, Stefan Tanaka, Piet Jansen, Sanne Vermeer. The Sales scope shows **7**: Alex Former is a leaver whose account is disabled. |
    | **2** | **5** — `SG-AllEmployees`, `BR-Employee-Base`, `BR-Sales`, `SG-Sales`, `SG-CRM-Users`. |
    | **3** | **Tom Bakker** (Operations) and **Nadia Haddad** (Marketing). Both hold `BR-Sales`: Tom transferred out of Sales and it was never revoked, Nadia has it for a joint campaign. |
    | **4** | He **inherits it through the `BR-Sales` business role** — it's a role-derived (`Indirect`) grant, not a direct one. He has no direct assignment on `SG-CRM-Users` at all. |
    | **5** | **`SG-Sales` and `SG-CRM-Users`** — the two the role grants. `SG-AllEmployees` is held directly by everyone in the company; `BR-Employee-Base` and `BR-Sales` are roles themselves, not access granted *by* a role. |
    | **6** | **`SG-Sales-SharePoint`** — held as a direct, ad-hoc grant by 5 of the 6 Sales members, and not part of `BR-Sales`. The obvious mining candidate. |
    | **7** | **`SG-Finance-Reports`** — and the reason matters as much as the name. It fits the same shape (4 of 6 Sales hold it directly), but it's **sensitive cross-department finance access**: Finance holds it legitimately, and of the Sales side only the **Sales Manager (Paul Quinn)** was ever certified for it — the certification says "approved for this role only". Folding it into `BR-Sales` would hand every rep the company's revenue and margin data. A least-privilege violation, not a role candidate. |

    **Track 2 — Cloud & accounts**

    | # | Answer |
    |---|---|
    | **8** | **Finance**, with 4 SAP accounts. Sales has 3, Operations 2, Engineering 1 — close enough that guessing doesn't work. |
    | **9** | **5 accounts**: Deploy Pipeline (service principal), info@fortigidemo.com (shared mailbox), Victor Wang, Wendy Xu and Piet Jansen. |
    | **10** | **Victor Wang, Wendy Xu and Deploy Pipeline** — the holders of a role on an `eastus` resource. Victor also holds one in `westeurope`, so he's in the answer either way. |

    **Track 3 — Apps & consent**

    | # | Answer |
    |---|---|
    | **11** | **5 users**: Piet Jansen, Rachel Smith, Hassan Ibrahim, Wendy Xu and Niels Olsen. |
    | **12** | **Piet Jansen and Wendy Xu.** The trap is **Victor Wang** — he has a never-expiring password *and* has consented to an app, but that app is Contoso Timesheets: verified publisher, `User.Read` only. Answer "consented to anything + never-expiring password" and you get 3. |

    **Piet Jansen** is the thread: role-inherited access (4), a never-expiring password (9), risky consent (11) and both at once (12). If your answers to those four don't all feature him, one of them is wrong.
