---
type: concept
prereq: concepts/data-model.md
outcome: You know what the number on an account or resource means before you trust it.
---

# What a Risk Score Means

!!! info "Before this page"
    Assumes you have read **[Data Model](./data-model.md)**.
    Brand new? Start at [The words you need first](../start/glossary.md).

A risk score is a number from 0 to 100 on an account or a resource. It answers one question: *how much attention does this deserve compared to everything else?* It is a ranking aid, not a verdict. A high score means "look here first", not "this is wrong".

Identity Atlas calculates the score itself, inside your own installation, from data the crawlers already collected. Risk scoring is an optional feature: it is switched off on a fresh install and turned on under **Admin → Risk Scoring**.

## What gets a score

A scoring run scores two kinds of things:

- **Accounts** — every account, human or not.
- **Resources** — everything that grants access: groups, directory roles, app roles, business roles and so on.

Each one gets a score, a tier, and an explanation of where the score came from.

## The four layers

The score is built from four layers. Each layer produces its own sub-score, and the final score is a weighted sum of the four.

| Layer | What it looks at | Sub-score range | Weight |
|---|---|---|---|
| **1. Classifier match** | Does the name, description, job title or another attribute match a pattern that marks it as sensitive? | 0–100 | 50% |
| **2. Membership analysis** | How the thing is connected: how many members, whether it has an owner, how many groups an account is in, whether it sits in a high-risk group. | 0–40 | 20% |
| **3. Structural hygiene** | Signs of poor upkeep: no description, a disabled account that still has access, a guest account, a long time since the last sign-in. | 0–25 | 10% |
| **4. Risk propagation** | Risk inherited from neighbours: an account takes on part of the score of its riskiest group, a resource part of the score of its riskiest member. | derived | 20% |

```
score = 0.50 × classifier match
      + 0.20 × membership analysis
      + 0.10 × structural hygiene
      + 0.20 × risk propagation
```

The result is rounded and capped at 100.

The weights tell you how to read a score:

- **Classifiers carry it.** Half of the score comes from layer 1. Something that matches no classifier can only collect points from the other three layers, which keeps it low.
- **Layers 2 and 3 nudge.** A full membership sub-score adds 8 points to the final score; a full hygiene sub-score adds 2.5. They separate two things that matched the same classifier; they do not make something risky on their own.
- **Layer 4 connects.** A plain account in a sensitive group gets a non-zero score because of the group, and a group picks up some score from a sensitive member.

A consequence of the weights: when classifier scores stay within 0–100, the four layers together produce at most 64. Scores in the High and Critical tiers therefore come from an analyst override, not from the engine alone.

### A worked example

The group *Finance Payment Approvers* matches a classifier with score 90. It has four members, an owner and a description. Its riskiest member is an account that matched a classifier with score 70.

| Layer | Sub-score | Why | Contribution |
|---|---|---|---|
| Classifier match | 90 | Best matching classifier | 45 |
| Membership analysis | 5 | Small group (1–5 members) | 1 |
| Structural hygiene | 0 | Nothing to flag | 0 |
| Risk propagation | 9 | 25% of the riskiest member's score before propagation (35) | 1.8 |

Final score: 48, tier Medium.

The exact signals behind each layer are listed in [How Scoring Works](../risk-scoring/overview.md).

## Tiers

The tier is a label for a score band. The cutoffs are fixed:

| Score | Tier |
|---|---|
| 90–100 | **Critical** |
| 70–89 | **High** |
| 40–69 | **Medium** |
| 20–39 | **Low** |
| 1–19 | **Minimal** |
| 0 | **None** |

## A score always explains itself

Open the **Risk** tab on an account's or resource's detail page. It shows the tier, the score, and the four layers with their weights. **Show Details** opens two lists:

- **Classifier Matches** — which classifiers matched, on which field, and on what text.
- **Score Explanation** — one line per signal, with the points it added. For example: *"No owner assigned while having 12 member(s) — ungoverned group [+5]"*.

If you cannot explain a score from these two lists, do not act on it.

## Overrides

A classifier is a pattern, and patterns are sometimes wrong. An analyst who knows better can adjust a score:

1. Open the detail page and go to the **Risk** tab.
2. Click **Adjust Score**.
3. Move the slider anywhere from −50 (lower risk) to +50 (higher risk).
4. Fill in **Reason (required)** — at least 3 characters, at most 500.
5. Click **Save Override**.

The score and tier are recalculated when you save, and the adjustment is shown next to the score. **Remove Override** takes it away again. Setting or removing an override requires the `data.write.risk` permission; see [Permissions](../reference/permissions.md).

A scoring run rebuilds every score from the current data, and a run follows every crawl. An override therefore holds until the next scoring run.

## What is stored

Each scored account or resource has one row of results:

| Field | Meaning |
|---|---|
| `riskScore` | The score, 0–100 |
| `riskTier` | `Critical`, `High`, `Medium`, `Low`, `Minimal` or `None` |
| `riskDirectScore` | Layer 1 sub-score |
| `riskMembershipScore` | Layer 2 sub-score |
| `riskStructuralScore` | Layer 3 sub-score |
| `riskPropagatedScore` | Layer 4 sub-score |
| `riskClassifierMatches` | The classifiers that matched, with the field and text that matched |
| `riskExplanation` | The reasons per layer |
| `riskOverride`, `riskOverrideReason` | The analyst adjustment and its reason |
| `riskScoredAt` | When the score was calculated |

Only the latest run is kept: a new scoring run replaces the previous results.

## What a score does not tell you

- **It does not read permissions.** The engine works from names, descriptions, attributes and who-is-in-what. A group with a bland name and no description does not score high because of what it unlocks.
- **It is only as good as the classifiers.** The classifiers are generated for your organisation and can be regenerated; see [Classifiers](../risk-scoring/classifiers.md).
- **It is relative.** Use it to decide where to look first, then open the detail page and judge for yourself.
