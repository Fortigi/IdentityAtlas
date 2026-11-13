---
type: concept
prereq: risk-scoring/overview.md
outcome: You can read, and change, the rules that decide what counts as sensitive.
---

# Classifiers

!!! info "Before this page"
    Assumes you have read **[How Scoring Works](./overview.md)**.
    Brand new? Start at [The words you need first](../start/glossary.md).

A classifier is a rule that says: *anything whose name or attributes look like this is sensitive, and this is how sensitive.* It is a set of regular expressions with a score attached. Classifiers decide half of every risk score, so they are the first place to look when a score surprises you.

There is no built-in set. Classifiers are generated for your organisation from a risk profile, and scoring does not run until a classifier set is active.

## Where they come from

1. The **risk profile** describes your organisation: industry, country, applicable regulations, critical roles, known systems, critical business processes and risk domains.
2. The AI provider turns that profile into a **classifier set**: patterns for the roles, systems and regulations the profile names.

Both are created in the Risk Profile Wizard: **Admin → Risk Scoring → New profile**. The steps are described in [How Scoring Works](./overview.md#setting-it-up).

## Reading the active set

Open **Admin → Risk Scoring** and expand **Risk Classifiers**. The header shows the name, version, AI model and generation date of the set. Below it are three tabs:

| Tab | Applied to |
|---|---|
| **Groups** | Every resource — groups, roles, business roles and all other resource types |
| **Users** | Human accounts |
| **Agents** | Service principals, managed identities, workload identities and AI agents |

Each row is one classifier:

| Column | Meaning |
|---|---|
| **Label** | The name of the rule, with a one-line description of why it matters |
| **Patterns** | The regular expressions. A classifier matches when any one of them matches. |
| **Score** | The layer 1 sub-score an account or resource gets when this classifier matches, 0–100 |
| **Tier** | The severity the generator had in mind: critical, high, medium or low |
| **Domain** | The regulation or risk domain from the profile that the rule belongs to |

The same content is available as raw JSON at the bottom of the section:

```json
{
  "version": "1",
  "groupClassifiers": [
    {
      "id": "payment-approvers",
      "label": "Payment approvers",
      "description": "Groups that can approve outgoing payments",
      "patterns": ["\\bpayment[\\s_-]?approv(er|al)s?\\b"],
      "score": 90,
      "tier": "critical",
      "domain": "financial-integrity"
    }
  ],
  "userClassifiers": [],
  "agentClassifiers": []
}
```

<!-- screenshot: Admin → Risk Scoring with the Risk Classifiers section expanded on the Groups tab -->

## What happens when a classifier matches

During a scoring run every pattern is tested, case-insensitively, against the text fields of each account and resource. The fields are listed in [How Scoring Works](./overview.md#layer-1-classifier-match).

- **The highest score wins.** When several classifiers match, the layer 1 sub-score is the highest score among them. Scores are not added up.
- **Layer 1 counts for half.** A match with score 90 contributes 45 points to the final score.
- **Every match is recorded** with the field that matched and the text it matched on. You see them under **Classifier Matches** on the **Risk** tab of the detail page.
- **A match spreads.** A resource whose layer 1 sub-score is 70 or higher adds points to each of its members, and part of every score is passed on between a resource and its members.

Two things can reduce or cancel a match:

- A resource whose name marks it as a non-production environment keeps a quarter of the sub-score.
- A match on text about news bulletins, meeting rooms, calendars, shared mailboxes or distribution lists is dropped.

The **Tier** on a classifier is descriptive. The tier of an account or resource always follows from its final score.

## Changing the classifiers

Classifiers follow from the risk profile, so that is where you change them.

1. Go to **Admin → Risk Scoring** and click **New profile**.
2. Generate the profile again, then use the refinement chat to correct it. Name what is missing or wrong: "add a critical role for the customs desk", "we do not use SAP".
3. Save the profile, then click **Generate classifiers**. If the result is not right, click **Regenerate**.
4. Save the set with **Activate** ticked.
5. Run scoring.

Saving creates a new set and leaves earlier sets in place. One set is active at a time; activating a new one deactivates the previous one.

### Pattern rules

Patterns are checked when a set is saved, and a set with an invalid pattern is refused.

- Patterns are matched case-insensitively. Do not add an inline flag such as `(?i)`.
- Lookahead, lookbehind and backreferences are not supported.
- Anchor keywords with `\b` and pair broad words with something specific. `\badmin\b` matches far too much; `\bpayment[\s_-]?admin\b` matches what you mean.
- Every field is tested, descriptions included. A pattern that reads well against a name can still match an unrelated description.

### Saving a set through the API

A hand-edited classifier set can be saved and activated through the API. This requires the `admin.llm` permission.

| Request | Purpose |
|---|---|
| `GET /api/risk-classifiers` | List saved sets |
| `GET /api/risk-classifiers/:id` | Read one set, including its patterns |
| `POST /api/risk-classifiers` | Save a set. Body: `displayName`, `classifiers`, and optionally `profileId` and `makeActive` |
| `POST /api/risk-classifiers/:id/activate` | Make a saved set the active one |
| `DELETE /api/risk-classifiers/:id` | Delete a set |

## When a score looks wrong

1. Open the detail page, go to the **Risk** tab and click **Show Details**.
2. Under **Classifier Matches**, read which classifier matched and on what text.
3. If the pattern is too broad, change the classifiers as described above and run scoring again.
4. If the classifier is right but this one case is an exception, [adjust the score](../concepts/risk-scoring-model.md#overrides) instead.
