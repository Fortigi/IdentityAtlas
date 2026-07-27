---
type: start
prereq: start/glossary.md
outcome: You know whether you are ready for the flags, and where to go for whichever idea you are missing.
---

# Before you play

[Capture the Flag](capture-the-flag.md) is twelve questions hidden in the demo data. It does not assume you have an IAM background — but it does assume you know six ideas. This page is the readiness check.

It contains **no answers and no spoilers.** Read it freely.

---

## Six questions. Can you answer them?

Answer each one to yourself. Every "no" has a link.

1. **What is the difference between an identity and a principal?**
   If the answer is not roughly *"one is the person, the other is one of their logins"* → [The words you need first §3](../start/glossary.md#3-identity)

2. **What is a resource here?**
   If you said "a file" or "a server", it is broader than that → [§4](../start/glossary.md#4-resource)

3. **What do Direct, Indirect and Eligible mean on an assignment?**
   These three words carry most of the twelve flags → [§5](../start/glossary.md#5-assignment)

4. **What makes an assignment *governed*?**
   If "governed" and "granted" sound like the same thing, you will lose two flags → [§6](../start/glossary.md#6-group-and-role-the-difference-people-get-wrong)

5. **What is a context, and what does a plugin do to one?**
   Track 3 does not start until you have this → [§11](../start/glossary.md#11-context)

6. **How do you decide who and what is in the matrix?**
   That is the *scope*, and it is the only control you really need → [§10](../start/glossary.md#10-scope)

**Six yeses?** Go and play. **Any nos?** Eight minutes on [The words you need first](../start/glossary.md) fixes all six at once, and [Your first 15 minutes](../start/first-15-minutes.md) turns them into muscle memory on the same data the flags are hidden in.

---

## Three mechanics that trip people up

Not concepts — controls. Knowing these is the difference between "the product cannot answer this" and "I did not find the button."

**The badge is the answer, not the cell.** Nearly every flag turns on *how* access is held rather than whether it is held. A filled cell tells you very little. Read the badge.

**You can filter on attributes the crawler brought along, not just the ones on screen.** The filter wizard can build conditions on source-system attributes — they are prefixed `ext.`. Several flags are unanswerable until you know that box exists.

**Both sides of the grid filter independently.** People down the side, resources across the top, each with their own conditions. The harder flags are simply *both* sides filtered at once — not a cleverer feature.

---

## House rules, in one line each

- **Honour system.** The answers are in this open repo. Looking them up scores nothing.
- **Hints are free.** Every flag has one. Use them all.
- **The demo resets nightly.** Click anything. Break anything.
- **The data is synthetic.** Fortigi Demo Corp does not exist and neither do its people.

!!! danger "One page to avoid"
    [Demo Dataset](../architecture/demo-dataset.md) is the engineering reference for this data and it contains the full answer key. Do not open it until you are finished.

---

**Ready.** → [Capture the Flag](capture-the-flag.md)
