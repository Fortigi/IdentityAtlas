# Design archive

**Everything in this section is a design document, not a description of the product.**

These pages were written *before* the thing they describe was built. Some were built exactly as written. Some were built differently. Some were never built at all. They are kept because the reasoning in them is worth having — the alternatives considered, the trade-offs, why the shape is the shape.

!!! warning "Do not read these as documentation of current behaviour"
    If you want to know what Identity Atlas does today, use [Learn](../concepts/data-model.md) for the model, [Use](../ui/overview.md) for the screens, and [Reference](../reference/config.md) for the exact contracts.

    A design document that says "not yet implemented" may describe a feature that shipped two versions ago — the header was accurate when it was written and nobody went back to change it. That mismatch is precisely why these pages now live behind their own signpost instead of alongside the user documentation.

## What is in here

| Document | Status of the thing it describes |
|---|---|
| [Context Redesign](context-redesign.md) · [Plan](context-redesign-plan.md) · [UI](context-redesign-ui.md) | **Shipped.** Contexts, `ContextMembers` and the plugin registry are live. Read [Contexts](../ui/contexts.md) for how it actually works. |
| [Assignment Model Redesign](assignment-model-redesign.md) | **Shipped.** `assignmentType` is now only `Direct` / `Indirect` / `Eligible`; ownership and governance moved to a resource and a flag. See [Data Model](../concepts/data-model.md). |
| [IdentityType Design](identitytype-design.md) | Partially reflected in the shipped model. |
| [Risk Scoring Plugins](risk-scoring-plugins.md) | **Proposal.** Not built. |
| [Rule Mining Discussion](rule-mining-discussion.md) | **Exploration.** A discussion, not a plan. |

## Why keep them at all

Deleting them would lose the reasoning, and the reasoning is the expensive part. Leaving them in the main navigation cost us something worse: readers took proposals for product truth, and a documentation audit found people believing shipped features did not exist because a design page still said "not yet implemented".

So they stay, together, clearly labelled, one click off the main path.

## Adding a page here

If you write a design document, put it in this section from the start — not in the user documentation with a status header. Status headers rot; the section it lives in does not.
