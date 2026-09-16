# Report generator — evaluation set v2 (plan)

**Status:** plan, not built. Branch `feature/nl-reports-eval`, stacked on the custom reports PR (#1223).

## Why a new evaluation set

The current sets (`questions.json`, 39 questions; `holdout.json`, 17) got the feature to a shippable
state. They cannot tell us whether it generalises:

- **Written by the people who built it**, in their own phrasing — and the tuning set was partly fitted
  to that phrasing.
- **One tenant.** A question passes when it returns the same *rows* on Fortigi's data. That does not
  carry over to another tenant, and a question whose right answer is empty cannot tell a right
  definition from a wrong one.
- **One phrasing per question.** A functional test on 2026-09-16 showed why that matters: *"Can you
  show me the groups that Wim has that William doesn't?"* and *"Can you create a report of groups that
  Wim has that William doesn't?"* produced two different definitions — one of them without any name
  confirmation, both wrong.
- **Holdout by question, not by kind of question.** Nothing measures how the model handles a type of
  question it has never seen an example of.

So the scores we quote (34/39, 14/17) say "good on questions like ours, on data like Fortigi's". This
plan is about measuring beyond that — before choosing between better prompt examples, retrieving
examples per question, or fine-tuning the model.

## What we want to measure

| # | Question | Measured by |
|---|---|---|
| 1 | Does it translate each **kind** of question correctly? | Accuracy per pattern |
| 2 | Is it **robust to phrasing**? | Share of phrasings of one pattern that give an accepted definition, and whether they agree with each other |
| 3 | Does it handle **kinds of question it has never seen**? | Accuracy on held-out patterns |
| 4 | Does it **ask when it should** — and only then? | Asked on genuinely ambiguous cases / asked on clear ones |
| 5 | Does it **recognise named objects** (people, groups, roles)? | Named objects in the question that reached the lookup and were confirmed |
| 6 | How long does it take? | Median, p90 and slowest per pattern |

Two things are measured **separately, without the model**, because they are ordinary engineering and
depend on the size of the tenant, not on language:

- **Name lookup at scale** — many people called Wim, similar group names, disabled accounts.
- **Query cost at scale** — comparisons across tens of thousands of groups against the 15 s statement
  limit and the row cap.

Both belong on the large synthetic dataset.

## The core idea: patterns, not questions

A **pattern** is one analytical intent — "groups that are good candidates for a business role" —
with:

- its **meaning**, in plain words, written by the person who knows what the answer should be;
- **slots** for the named objects it is about (a business role, two people, a group);
- one or more **accepted definitions**, with the slots as placeholders;
- whether it is **ambiguous**, and if so what the acceptable ways of resolving it are;
- **phrasings**: the different ways someone would actually ask it, in English and Dutch.

A **case** is a pattern + one phrasing + real names filled into the slots for the tenant the evaluation
runs on. The same pattern file then runs on Fortigi, on the synthetic dataset, or on a customer tenant.

### Worked example — "good candidates for a business role"

Wim's question: *"Which groups would be good candidates to add to business role ABC?"*
Meaning: *groups whose members are the same as the business role's members — and that are not already
part of that role.*

```yaml
id: br-candidate-groups
intent: Groups that would be good candidates to add to a business role
meaning: >
  Groups whose members are the same as, or mostly the same as, the members of the business role,
  and that are not already part of that business role.
slots:
  role: business-role          # the harness picks a real business role with members
ambiguous: similarity           # "good candidate" does not say how similar is similar enough
accept:
  - # identical membership, not already in the role
    entity: group
    conditions:
      - { type: compare, relation: members, measure: identical, reference: { entity: resource, name: "{role}" } }
      - { type: relation, relation: businessRoles, quantifier: none, conditions: [ { field: displayName, op: eq, value: "{role}" } ] }
  - # mostly the same (any threshold from 50% up), not already in the role
    entity: group
    conditions:
      - { type: compare, relation: members, measure: similar, minSimilarity: ">=50", reference: { entity: resource, name: "{role}" } }
      - { type: relation, relation: businessRoles, quantifier: none, conditions: [ { field: displayName, op: eq, value: "{role}" } ] }
on-ambiguity: ask-or-state     # pass if it asks how similar, OR picks an accepted reading AND says which
phrasings:
  en:
    - Which groups would be good candidates to add to business role {role}?
    - Show me groups that could be added to the {role} role
    - What groups have the same people as business role {role} but aren't in it yet?
  nl:
    - Welke groepen zijn goede kandidaten om toe te voegen aan bedrijfsrol {role}?
    - Welke groepen hebben dezelfde leden als {role} maar zitten er nog niet in?
source: Wim, 2026-09-16
split: tuning
```

### Worked example — "what A has that B doesn't"

```yaml
id: groups-a-has-b-lacks
intent: Groups one person is in and another person is not
meaning: Groups that have person A as a member and do not have person B as a member.
slots:
  a: user                        # two users with overlapping but different group memberships
  b: user
accept:
  - entity: group
    conditions:
      - { type: relation, relation: members, quantifier: some, conditions: [ { field: displayName, op: eq, value: "{a}" } ] }
      - { type: relation, relation: members, quantifier: none, conditions: [ { field: displayName, op: eq, value: "{b}" } ] }
must-confirm: [a, b]             # both people must reach the name lookup
common-mistake: >
  Reaching for "compare with" (how similar two sets are) — it cannot express what one has that the
  other lacks. Seen on 2026-09-16 with 0 rows as the result.
phrasings:
  en:
    - Can you show me the groups that {a} has that {b} doesn't?
    - Can you create a report of groups that {a} has that {b} doesn't?
    - Which groups is {a} in but {b} isn't?
  nl:
    - Welke groepen heeft {a} die {b} niet heeft?
source: Wim, 2026-09-16
split: tuning
```

## How a case is graded

1. **Named objects.** The harness fills the slots with names that exist in the tenant, plus deliberately
   *partial* names ("Wim" for "Wim van den Heijkant") in some phrasings. When the builder asks "did you
   mean", the harness picks the right record by id — and records that it was asked (measure 5).
2. **Definition equivalence, not rows.** The generated definition is normalised — condition order,
   defaults, implied types, columns ignored unless the pattern cares — and compared with each accepted
   definition. Thresholds can be ranges (`">=50"`).
3. **Ambiguity.** For an ambiguous pattern, asking about that ambiguity passes; so does an accepted
   definition *with* an assumption naming the choice it made. A silent pick of one reading fails.
4. **Rows as a second check.** On a tenant with known data, the rows are still compared — a definition
   that "looks equivalent" but returns something else is a harness bug worth knowing about.

## Splits — keeping the numbers honest

- **Held-out patterns (~25%)** are never shown to anyone changing the prompt. They measure question
  types the model has no example of.
- **Held-out phrasings** within tuning patterns (~1 in 3) measure robustness to wording.
- A failure in the held-out set is **reported, not fixed** in the same round. Once it is used to change
  the prompt, that pattern moves to tuning and a new one takes its place.
- Phrasings are marked **human** or **generated**. Generated paraphrases are useful for volume but too
  uniform to be the headline number; the headline is human phrasings only.

## Where the questions come from

1. **Wim, now** — the role-mining and governance questions customers actually ask.
2. **Fortigi consultants** — people who did not build the feature, writing how customers phrase things.
   This is the most valuable source for measure 2.
3. **Later, with consent** — real questions from the audit log (question text is already logged), with
   names replaced by slots. Only from customers who agree, and never with the result or the data.

### How to add a question (no JSON needed)

For each one, send:

- **The question**, as a user would type it.
- **What it means**, in plain words — what should the report list?
- **The named objects** in it (a person, a group, a role), if any.
- **Clear or ambiguous?** If ambiguous: what are the reasonable readings, and should it ask or pick one?

The definitions, the slots and extra phrasings are written from that; you review the *meaning*, not the
JSON. Where a question cannot be expressed in the definition language at all, it is recorded as a
**gap** — that list is the input for new building blocks.

## Practical constraints

- **Run time.** At ~50 s per question on 2 CPUs, 50 patterns × 6 phrasings = 300 cases ≈ **4–5 hours**
  per full run. Options: run on a sidekick with more CPUs (answer time scales with CPUs), run overnight,
  and sample phrasings for quick checks with the full run before a release.
- **Tenant data.** Slot filling needs rules per slot kind ("a business role with at least 5 members",
  "two users sharing some but not all groups"). If a tenant has no valid values, the case is skipped
  and reported, not failed.
- **The existing sets stay** until v2 has a baseline, so today's numbers remain comparable.

## Steps

| # | Step | Output |
|---|---|---|
| 1 | Pattern format + a converter for the 56 existing questions | `tools/nl-reports/patterns/*.yaml`; current sets still run |
| 2 | Harness v2: slot filling, definition normalisation and equivalence, ambiguity rules, per-pattern metrics | `eval.mjs` v2 with a per-pattern report |
| 3 | Intake: Wim's questions, then consultants' | first ~30–50 patterns, with gaps listed |
| 4 | **Baseline** on the current release (sk9, Fortigi) | per-pattern accuracy, phrasing robustness, held-out pattern score |
| 5 | Name lookup and query cost on the synthetic dataset — without the model | disambiguation and performance findings |
| 6 | Fixes, each measured against the baseline — starting with name recognition before the model runs and the "A has, B lacks" pattern | before/after per pattern |
| 7 | **Decision**: better examples, per-question example retrieval, or fine-tuning | based on where the misses cluster |

The decision in step 7 is the reason for all of this: if the misses are a handful of patterns, examples
fix them; if they are spread across phrasings, retrieval helps; if held-out patterns fail broadly, the
model has to learn the structure, and that is fine-tuning.
