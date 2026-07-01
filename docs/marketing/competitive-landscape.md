# Where Identity Atlas Fits

How to place Identity Atlas against the tools buyers already know — and the
through-line for "why this, and not the thing we already have?"

The short version: **Identity Atlas sits in an empty seat between two mature
categories.** Governance suites know *what access exists* but keep their scoring
closed. Attack-path and posture tools reason about *why an identity is dangerous*
but aren't built for governance work. Identity Atlas does both — visible,
explainable authorization intelligence with an open, extensible risk layer — and
it's open source.

## The two neighbouring categories

**Identity Governance (IGA) suites** — SailPoint, Saviynt, Omada, Microsoft Entra
ID Governance. These *provision and certify* access: access requests, reviews,
lifecycle. They increasingly include risk scoring and analytics, and they're
strong at governance workflow. What they don't offer: an open model you can read
and extend. The scoring is proprietary, and you consume a number rather than
authoring the logic behind it.

**Attack-path & posture tools** — BloodHound / AzureHound, ROADtools, Cartography,
ScoutSuite. These are excellent at *collecting the graph* and revealing *why* a
principal is reachable or dangerous. They're often open source. But they're built
for red teams and posture snapshots, not for the day-to-day governance question of
"who has what, is it right, and has anyone reviewed it?"

Identity Atlas borrows the best instinct from each: the **governance surfaces** of
the first (a role-mining matrix, IST-vs-SOLL, entity history) and the **"explain
the why"** instinct of the second — then makes the *why* a queryable segment you
can cross against access.

## What's genuinely differentiated

Risk scoring itself is table stakes now — every serious platform has some. Two
things are rarer, and they're where the story lives:

1. **An open, explainable, extensible risk layer.** Risk factors carry a
   human-readable reason, allow an analyst override with an audit trail, and — on
   the roadmap — can be extended with new scoring plugins rather than waiting on a
   vendor. Commercial suites keep this closed because it's their moat.

2. **The reason a user is risky becomes a filter.** "Admins who consented to a
   risky app" or "users with access to a critical system" aren't buried inside a
   score — they're segments you can scope the matrix to. That bridges the
   attack-path world's *why* with the governance world's *what access*, which no
   single product — open or closed — packages together today.

## Is there anything open source like it?

Not squarely. The closest open-source neighbours solve a *different* job:

| Project | What it does | Why it isn't the same job |
|---|---|---|
| midPoint, Apache Syncope, OpenIAM | Open-source IGA — provisioning, reconciliation, policy | *Change* access; not built for authorization visibility & mining |
| BloodHound / AzureHound, ROADtools, Cartography | Graph & attack-path across Entra/cloud | Red-team / posture focus; no governance UX or matrix |
| Keycloak, Zitadel, Authentik | Login / SSO / token issuance | Access *management*, not governance analytics at all |

Identity Atlas occupies the seat between the first two rows — governance-grade
*understanding* of access, open source, with an explainable risk layer that widens
the gap rather than closing it.

## Using this in conversation

- **Against an IGA suite:** "It complements what you have — we make the access
  *visible and explainable*, and our risk model is open, not a black-box score."
  Don't position as a rip-and-replace for provisioning; that's not the job.
- **Against attack-path tooling:** "Same *why-is-this-risky* instinct, but built
  for governance — a matrix, IST-vs-SOLL, history — not just a red-team snapshot."
- **On open source:** lean on it. Very few tools in this niche are open source at
  all, and none combine the matrix, mining, governance, and an extensible risk
  layer.

## Guardrails

- **Don't disparage.** Name categories and honest trade-offs, not vendor
  put-downs. "Complementary," "different job," "closed vs. open" — never "worse."
- **Complement, don't rip-and-replace.** Identity Atlas reads and reasons about
  authorization; it doesn't provision. Positioning it as an IGA-suite replacement
  invites a comparison it isn't trying to win.
- **The extensible risk-plugin layer is roadmap, not shipped.** Describe it as a
  direction; the risk scoring that ships today is the LLM-assisted engine
  ([key messages](key-messages.md), [proof points](proof-points.md)).
- **It's a fast-moving space.** Vendor marketing outpaces reality. Keep "no one
  else does this" as "we're not aware of a product that combines…" — accurate and
  still strong.

*Sources: [Product Brief](product-brief.md), [Key Messages](key-messages.md),
[Proof Points](proof-points.md), [awesome-entra](https://github.com/merill/awesome-entra)
(ecosystem index), [BloodHound](https://bloodhound.specterops.io/),
[midPoint](https://evolveum.com/midpoint/).*
