# Risk-Scoring Plugins — Design Proposal

> **Status: Proposal for review — not yet implemented.** No code ships from this
> document. It captures the design so it can be reviewed before any build starts.
> An independent architecture review pass has already been run against the current
> code; its material corrections are incorporated below (see *Design review notes*).

## 1. Motivation

Identity Atlas can already **group** risky things into Contexts and scope the matrix
to them (e.g. the `risky-consent` context plugin groups risky OAuth/app grants). That
works, but it leaves the analyst asking **"why is this risky?"** — a context has no
explanation and no way to say "we reviewed this, it's fine."

Separately, we have **one** risk-scoring feature: an LLM generates an org risk profile
+ classifiers, and `engine.js` scores entities. It has explanation and analyst override,
but it is **hard-wired to that one engine** — there is no way to add app-consent risk,
attack-path risk, or Azure-permission-tiering risk as first-class, explainable scorers.

**This proposal** turns risk scoring into a **plugin tier** so that:
- risk can come from **many sources** (org LLM, app consent, later attack-path / EntraOps),
- every risk carries an **explanation** ("why") and supports **manual override**,
- the **reason** an entity is risky becomes a **Context**, feeding the matrix so you can
  ask specific questions ("which admin accounts consented to a risky app", "who has
  access to critical system X").

### What it brings
- Explainable risk: every score is backed by a rationale + structured evidence.
- Analyst trust: per-finding override with reason, preserved across re-runs.
- Extensibility: new risk sources are plugins, not forks of the engine.
- Matrix leverage: risk becomes filterable context, intersectable with any other context.

## 2. Current state (grounded in the code)

- **Context plugins**: `app/api/src/contexts/plugins/` (`registry.js`, `runner.js`,
  `types.js`), seeded via `contexts/seedAlgorithms.js` into `ContextAlgorithms`; runs
  tracked in `ContextAlgorithmRuns`; output persisted to `Contexts`/`ContextMembers` by
  the runner's `reconcile()`.
- **Risk scoring**: `app/api/src/riskscoring/engine.js` (the scorer) + `routes/riskScores.js`,
  `routes/riskProfiles.js`, `routes/riskScoringRuns.js`. The engine reads **`RiskClassifiers`**
  (`isActive`) and **`RiskProfiles`** (migration 010); the `Graph*Risk*` tables (004) are dead
  v4 schema. Run progress is tracked in **`ScoringRuns`** (010, bigserial).
- **`RiskScores`** (004): PK `(entityId, entityType)`, one **composite** row per entity, with
  `riskScore`/`riskTier`, four sub-scores (direct/membership/structural/propagated),
  `riskExplanation` (JSONB), `riskClassifierMatches` (JSONB), and `riskOverride`/`riskOverrideReason`.
- Two known facts that shape the design:
  1. `runScoring` does `DELETE FROM "RiskScores"` then re-inserts — which **wipes overrides on
     every run** (a latent bug we must not carry forward).
  2. `Principals`/`Resources.riskScore` are **near-vestigial** — the matrix read path joins
     `RiskScores` directly; those denorm columns are only written on override today.

## 3. Core concept: the *finding*

The atom of the new system is a **risk finding**:

> *Plugin **P** says entity **E** is risky because of factor **F**, with score **S**,
> here's the rationale + evidence, and an analyst may override it.*

Everything derives from findings:
- **Composite** per entity = a rollup of its findings ("how risky overall").
- **Contexts** = findings grouped by **factor** → one Context per reason, members = the
  entities with that finding. This is what feeds the matrix.

The **factor** is the key idea (from review feedback): not a generic "top risky users"
list, but the *specific driver* — `consented-malicious-app`, `classifier:privileged-admin`,
`critical-system-access:SAP` — so the matrix filters by *reason* and you intersect it with
any other context (admins ∩ "consented to a risky app").

## 4. Architecture

A **separate** risk-scoring plugin tier, parallel to context plugins:

```
context-algorithm plugins            risk-scoring plugins  (NEW)
  registry / runner / types            registry / runner / types
  → Contexts / ContextMembers          → RiskFindings → composite RiskScores
        (reconcile)                     → Contexts / ContextMembers  (via shared reconcile)
```

- Risk plugins **own** findings-persistence + composite rollup (genuinely new logic).
- Risk plugins **delegate context emission** to the context runner's `reconcile()` —
  which is extracted into a **shared module** so there is one copy of the hard logic
  (stale-context cleanup, analyst-edit preservation, parent-FK two-pass, member-count
  rollup). *No second copy of reconcile.* (Review finding H1.)

### Plugin contract
```
{ name, displayName, description, targetType, parametersSchema, needsExternalData,
  async run(params, ctx) => { findings: RiskFinding[], contexts?: ContextNode[] } }
```
Registered in a `riskscoring/plugins/registry.js`; seeded into a new
**`RiskScoringAlgorithms`** table (mirrors `ContextAlgorithms`, with the same
disable-orphans-on-reseed behaviour we already use for context algorithms).

## 5. Data model

**`RiskFindings`** (new) — one row per (plugin, entity, factor):

| column | notes |
|---|---|
| `id` uuid, `runId` uuid, `pluginName` text | |
| `entityId` uuid, `entityType` text | Principal / Resource / Identity |
| `factor` text, `factorLabel` text | the driver key + human label; **drives context grouping** |
| `score` int, `severity` text | Critical / High / Medium / Low |
| `rationale` text | the human-readable "why" |
| `evidence` jsonb | structured proof (appId, scope, classifier match, sub-scores, critical system…) |
| `weight` numeric | contribution to composite |
| `overrideScore` int, `overrideSeverity` text, `overrideReason` text, `overrideBy` text, `overrideAt` | per-finding override |
| `createdAt` | |
| **UNIQUE** (`pluginName`, `entityId`, `entityType`, `factor`) | re-runs upsert |

**Composite** reuses **`RiskScores`** as the per-entity rollup. Critical rules (review C2/H4/M2):
- Findings upsert with `ON CONFLICT DO UPDATE` touching **engine-owned columns only** —
  **never** the `override*` columns. (Fixes today's override-wipe bug.)
- Composite recompute is a **set-based** `INSERT … SELECT` from `RiskFindings` grouped by
  `(entityId, entityType)` over **all** plugins, in a transaction, touching only entities
  whose findings changed this run — **never** a blanket `DELETE FROM RiskScores` (that would
  wipe other plugins' contributions + overrides).
- **Stale findings** (an entity no longer flagged by a plugin this run) are deleted per-plugin
  (mirroring reconcile's stale delete) → recompute → composite **resets to 0/None** when an
  entity drops out.
- Stop writing the `Principals`/`Resources.riskScore` denorm (near-vestigial; reads join
  `RiskScores`). *(Decision — see §9.)*

**Runs**: a new **`RiskScoringRuns`** (UUID PK, `pluginName`, status/summary) rather than
overloading the bigserial `ScoringRuns` progress table.

## 6. Reason → Context generation

A **shared runner step** turns findings into Contexts, grouped by `(pluginName, factor)`:
each meaningful factor → one Context (`contextType='RiskFactor'`, `extendedAttributes`
carry `riskPlugin`/`factor`/`severity`), members = the entities with that finding.

Review-driven correctness (H2/H3):
- Risk-factor contexts are **cross-system** (`scopeSystemId = NULL`), where the existing
  partial unique index does not protect them → add a partial unique index for
  `(sourceAlgorithmId, externalId) WHERE scopeSystemId IS NULL`, and pin a **stable
  instanceKey per risk plugin** (never a fresh UUID per run, which would spawn duplicate
  trees / context explosion).
- Findings can be **both Principal and Resource** (org-risk scores both), but
  `Contexts.targetType` / `ContextMembers.memberType` are single-valued → the emission step
  sets `memberType` from each finding's `entityType`, not a global `plugin.targetType`.
- Curate to avoid context explosion: only emit a factor-context when it has ≥ N members /
  is a meaningful driver (configurable).

## 7. The plugins

### org-risk (migrate the existing LLM engine)
The current engine's composite is **not decomposable** into independent per-classifier
findings — it does cross-entity **propagation**, **max-over-classifiers** for the direct
layer, additive layer caps (40/25), a final cap of 100, and non-prod / meeting-room
guardrails. So (review C3):
- org-risk **passes through** its own final score as the composite (no re-aggregation),
- findings carry the sub-scores + classifier matches in `evidence` for explainability and
  for context grouping,
- contexts are emitted per classifier / driver → "users matching *Privileged Admin*",
  "users with access to critical system *SAP*", etc. — the reason becomes the context.
- LLM profile/classifier generation stays as this plugin's **config step** (targeting the
  real `RiskClassifiers` / `RiskProfiles` tables).

Parity is then exact by construction; a golden test comparing old-engine vs new-composite
on real data is a **guard**, and retiring the old path is gated on both the parity test and
an **override-preservation** test.

### app-consent-risk (new — the wedge)
Scores **principals** (the consenters). Reuses `riskyConsentRiskMap.js` + `riskyAppFeed.js`.
Findings per (principal, factor): `high-risk-permission`, `malicious-app`, `suspicious-app`;
score/severity from the permission tier / app reputation; rationale ("consented to
`Group.ReadWrite.All` (High)"; "consented to *X* — flagged malicious by OAuthSentry");
evidence = the grant / app. Contexts per factor → "Consented to a malicious app", etc.
(principal members). Intersect with an admin context → "admin accounts that consented to a
risky app".

*Relationship to the existing `risky-consent` context plugin:* keep it — it groups the
*grants* (resources) for matrix columns. app-consent-risk scores the *principals* and adds
the "why". Both draw on the shared classification helpers. *(Overlap is a decision — §9.)*

### Future plugins (framework-ready, not built here)
- **attack-path** (BloodHound / Purple Knight): risky users by attack path.
- **EntraOps**: tiering of Azure RM permissions.
Both `needsExternalData`; both fit the same finding + reason-context shape.

## 8. Explainability, override, API, UI

- **Explainability**: every finding has `rationale` + structured `evidence`; the composite
  carries the contributing findings.
- **Override**: per-finding override (score/severity + reason + who/when), preserved across
  re-runs. The existing **entity-level** additive-delta override is kept as an override layer
  applied **after** rollup, so current analyst overrides are not lost. *(Decision — §9.)*
- **Plugin failure isolation**: a plugin writes its run's findings in one transaction; a
  partial/failed run does not fold into the composite.
- **API**: `/api/admin/risk-plugins` (list/run/last-run, like context-plugins);
  `/api/risk-findings?entityId=&entityType=`; a per-finding override endpoint; run history.
- **UI**: Admin → Risk Scoring becomes a **risk-plugin picker** (like the Plugins tab). Each
  plugin shows its config panel (org: the existing profile wizard + classifiers; app-consent:
  feed URL + thresholds), Run, last-run summary, and a findings view with per-finding
  rationale + override. Matrix scopes to the generated `RiskFactor` contexts (reuse existing
  context scoping — no new matrix code for v1).

## 9. Open decisions (for reviewer)

- **Composite formula**: proposed tier = max severity; score = **de-duped** weighted sum
  (a malicious app + its high-risk permission is one event, counted once); org-risk =
  pass-through. Override recomputes severity too.
- **Entity-level override**: keep the existing additive-delta override as an after-rollup
  layer (proposed) vs deprecate to per-finding only.
- **Overlap**: keep both `risky-consent` (grants) and `app-consent-risk` (principals)
  (proposed) vs fold the grant-context emission into the risk plugin later.
- **Denorm**: stop feeding `Principals`/`Resources.riskScore` (proposed) — confirm no
  external consumer relies on those columns.

## 10. Delivery (when we build — after the current demo cycle)

A reviewable **stack**, not one mega-PR:
1. **Framework + schema** — `RiskFindings`, `RiskScoringAlgorithms`, `RiskScoringRuns`,
   extract shared `reconcile()`, override-safe set-based composite, reason→context step,
   seed + disable-orphans. Test matrix **includes a dual-targetType, cross-system factor**
   up front (so H2/H3 surface now, not at slice 3).
2. **app-consent-risk plugin** (the wedge — proves the framework end-to-end incl. contexts).
3. **Migrate org-LLM → org-risk plugin** (pass-through; parity + override-preservation gated;
   retire the old engine path).
4. **UI** — risk-plugin picker + per-finding explanation/override + matrix scoping polish.
5. *(Later)* attack-path + EntraOps plugins.

## 11. Testing strategy
- Unit: risk-map / feed parsers (exist); composite rollup (de-dup, no-findings→reset, override
  precedence); reason→context emission (stale cleanup, per-finding memberType, NULL-scope
  uniqueness); plugin registry seed + disable-orphans.
- Contract (real PG16): `RiskFindings` upsert preserves overrides across re-run; set-based
  composite recompute over multiple plugins; stale-finding delete resets composite.
- Golden: org-risk composite parity (old engine vs new pass-through) on a representative
  dataset, before retiring the old path.

## Design review notes (incorporated)

An independent architecture review flagged, and this design incorporates: correct table
identifiers (`ScoringRuns`/`RiskClassifiers`/`RiskProfiles`, not `Graph*`); org-engine
**pass-through** instead of decomposition (avoids score drift); **sharing `reconcile()`**
instead of a second copy; **NULL-scope** context uniqueness + stable instanceKey; **per-finding
`memberType`**; **override-safe, set-based** composite recompute (fixing today's
override-wipe-on-run bug); stale-finding → composite reset; de-duped aggregation; and
plugin-failure isolation.
