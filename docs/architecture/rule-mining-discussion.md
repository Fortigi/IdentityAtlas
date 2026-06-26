# Rule mining / role candidate suggestions — design discussion handover

**Status:** In-progress discussion. Not yet a finalised design. Pick up from the "Open questions" section.

**Branch:** `claude/assignment-rules-discussion-SuoWm`

---

## The problem

Help analysts discover patterns linking principal attributes to resource assignments, and propose **role / rule candidates** with quality metrics. The two analyst outcomes that matter:

- **Gap candidates** — principals matching a rule's predicate but missing the predicted assignment.
  *"47 of 50 Finance Accountants have GL-System; here are the 3 who don't."*
- **Over-provision candidates** — principals holding assignments that no high-confidence rule predicts. Likely role drift over time as attributes changed but assignments stayed.

The tool is **analytical-only**. Candidates never become real BusinessRoles inside Identity Atlas — analysts take the proposal to a business owner, the role gets implemented in the IGA system, and it then re-enters Identity Atlas via the normal crawler import.

---

## Locked-in decisions

### 1. Plugin architecture (mirroring `resource-cluster`)

Each rule-mining algorithm is a **plugin** that registers at startup, following the same pattern as the context-algorithm plugins (see `app/api/src/contexts/plugins/resource-cluster/`). Open-source contributors can drop in their own. The plugin contract is **output-shaped, not algorithm-shaped** — a plugin returns candidate rules in a standard format; *how* it produced them (one algorithm, two stacked, hybrid) is internal.

Up to **4 active plugins** at once. Cap of **8 candidates total** across the matrix view, distributed evenly:

| Active plugins | Candidates per plugin |
|---|---|
| 1 | 8 |
| 2 | 4 each |
| 3 | 3 each (= 9, slightly over cap) |
| 4 | 2 each |

### 2. On-the-fly within the analyst's matrix scope

No batch generation of thousands of candidates. The analyst picks contexts / attribute filters → matrix loads with actual + governed assignments → registered plugins compute candidates **synchronously within the current scope** → analyst sees them as candidate columns → reviews and saves the keepers.

The matrix view already maxes at ~25 users (configurable). At this scale, compute is **not the bottleneck** — FP-Growth on 25 principals × ~50 attribute tokens × ~200 resources runs in milliseconds. Even 2000 principals stays sub-second.

### 3. Mining unit = per resource (default)

Resource clusters are too coarse — a "AXIOM developer" and a "AXIOM user" need different roles. Clusters serve as **scoping / navigation**, not as the RHS of a rule.

### 4. UI overlay on the matrix

Candidate columns appear **to the right of governed BusinessRoles**, visually distinct (dashed borders, muted palette, "candidate" badge). Hidden by default, toggled per-user via preferences.

- Click candidate column header → opens **detail subtab** showing rule, plugin, evidence, gap / over-provision principals.
- Cell decorations carry the value: amber dashed outline = gap; rose warning glyph = over-provision suspect.
- **Quality signal on the column header** (not buried in detail page) — e.g. `dept=Finance · 4/4 (n=4)` so analyst sees small N at a glance and doesn't overweight low-N rules.

### 5. Save = snapshot

When the analyst saves a candidate, materialise:

- `Resources` row with `resourceType='BusinessRoleCandidate'`
- `ResourceRelationships` with `relationshipType='Contains'` linking the candidate to its resources
- `ResourceAssignments` with `assignmentType='GovernedCandidate'` for the principals the rule predicts
- `extendedAttributes` JSONB on the Resources row stores: LHS predicate (structured), plugin name + version, run timestamp, matrix scope at save time, quality metrics

**The snapshot must NOT drift** when underlying data changes — the analyst is taking it to a stakeholder, the proposal shouldn't shift. If revisited later, UI should flag *"snapshot from date X; current data differs in these ways"*.

### 6. Lifecycle

`proposed` → `approved` (business sign-off recorded as state change) → `implemented` (real BusinessRole appears via crawler import, candidate marked done). Match between candidate and the eventually-imported real role is **manual at first** (analyst picks the real role from a dropdown). Auto-matching by resource-set similarity is v2.

### 7. Data model reuses existing tables

No new tables. `Resources` / `ResourceRelationships` / `ResourceAssignments` get new type discriminators (`BusinessRoleCandidate`, `GovernedCandidate`). The matrix view's existing query that joins these tables extends almost trivially.

### 8. Determinism and caching

- Plugins must be **deterministic** given identical inputs (or seed any RNG). Analysts lose trust if candidate columns reshuffle between page loads.
- Transparent cache keyed by `(scope, plugin, plugin-params, data-version)`. Reload the same matrix → instant. Sync runs → cache busts.

---

## The big simplification: contrastive scoring against the implicit complement

> This is the most important conclusion. It eliminates the need for any batch infrastructure in v1.

The analyst's prior Power BI prototype already computed exactly the right metric:

```
% Role Candidate = % users with assignment INSIDE scope
                 − % users with assignment OUTSIDE scope
```

This is **contrastive scoring with an implicit comparison cohort**. The comparison is *everyone the analyst isn't currently looking at* — defined by the inverse of the matrix filter, recomputed at query time. No precomputed baselines, no cohort picker, no staleness.

### What's good about this

- **One SQL query per matrix load.** `COUNT(*) FILTER (WHERE principalId IN scope) / |scope|` vs the same for the complement, grouped by `resourceId`, ordered by the difference, `LIMIT 8`.
- **Gap & over-provision signals fall out for free.** "31 in-scope users don't have this near-universal-in-scope assignment" *is* the gap list. The flip side is the over-provision signal.
- **Always fresh.** No baseline staleness because there are no baselines.
- **Self-consistent.** The comparison is exactly the population the analyst defined by *not* selecting it.

### What it costs

The analyst can't ask "what's specific to data analysts *within IT*?" without dilution from the rest of the company. The fix when (if) this becomes a pain: optionally let the analyst supply *two* filters — in-scope + "compare against" — instead of one. Plugin signature doesn't change; host passes a different complement set. **v2 problem, not v1.**

### Example (illustrative figures)

| Resource | % in-scope | % out-of-scope | Score |
|---|---|---|---|
| GG_ROL_All_Employees | 98.4% | 0.79% | 97.65 |
| _All_Users_Formal | 98.5% | 1.56% | 96.93 |
| GG_APL_O365_E5-Default | 97.0% | 1.92% | 95.06 |
| GG_ServiceNow-dev | 98.1% | 4.37% | 93.76 |
| GG_APP_ServiceNow_Allusers_P | 98.4% | 9.75% | 88.69 |

In-scope: 1984 users. The "31 do not — would get this if auto-assigned" annotation on the top row is the gap signal.

---

## Algorithm options surveyed

| Option | Output shape | Strengths | Weaknesses |
|---|---|---|---|
| **Contrastive scoring** (the Power BI prototype) | One score per resource | Trivial SQL. No precomputation. Already gives gap + over-provision. | Single-resource LHS only (the matrix filter). No multi-attribute rule discovery. |
| **FP-Growth / Apriori** (association rules) | Many IF/THEN rules per resource, support + confidence | Exhaustive within threshold. Output matches analyst mental model. | Combinatorial blowup without LHS attribute curation. No hierarchy. |
| **Decision tree / RIPPER** | A few rules per resource, leaf probability = confidence | Algorithm picks which attributes matter. Misclassification = gap/over-provision falls out naturally. | One model per resource. Class imbalance needs handling. |
| **Role mining proper** (FastMiner, ORCA, hybrid) | Multi-resource bundles + attribute explanation | Discovers *roles*, not single-assignment rules. Closest to IGA mental model. | Less off-the-shelf. More knobs. Output is harder to evaluate. |

**Where to start for v1:** the contrastive plugin as the default in-box plugin. FP-Growth and decision trees as alternate plugins shipped alongside. Role mining proper deferred.

---

## Plugin contract sketch (not yet finalised)

```
plugin = {
  name: string,
  version: string,
  description: string,

  // Optional. Heavy plugins implement this to precompute support structures
  // (similarity matrices, embeddings, FP-trees) against the full dataset
  // post-sync. Output is opaque to the host, keyed by data version.
  // Default: not implemented → no batch step.
  prepare?: (allData, ctx) => preparedArtefact,

  // Required. Runs synchronously at matrix load.
  compute: (scope, complement, assignments, prepared?, ctx) => Candidate[]
}

Candidate = {
  pluginName, pluginVersion,
  lhs: StructuredPredicate,        // e.g. { clauses: [{attr, op, val}, ...] }
  rhs: { type: 'Resource', id: string },
  principalSets: {
    matchers: principalId[],        // satisfy LHS
    holders: principalId[],         // satisfy LHS AND have RHS
    gaps: principalId[],            // satisfy LHS but lack RHS
    extras: principalId[]           // have RHS but don't satisfy LHS (over-prov signal)
  },
  quality: {
    score: number,                  // plugin's preferred ranker — host sorts by this
    metrics: object                 // plugin-defined: { inScopePct, outScopePct, support, confidence, lift, ... }
  }
}
```

The host:
- Calls `compute()` on each registered plugin at matrix load, in parallel where possible.
- Caches by `(scope, plugin, plugin-params, data-version)`.
- Schedules `prepare()` post-sync if defined; persists artefact by data version; passes it back into `compute()`.
- Renders candidates as columns sorted by `quality.score` per plugin, capped per the 8-total distribution.
- On save, materialises the snapshot into the Resources / ResourceRelationships / ResourceAssignments tables.

### What's in `extendedAttributes` on a saved candidate Resource

```json
{
  "ruleMining": {
    "plugin": "contrastive-v1",
    "pluginVersion": "1.0.0",
    "savedAt": "2026-05-12T14:30:00Z",
    "scope": { "contextIds": [...], "filters": {...} },
    "lhs": { "clauses": [{"attr": "dept", "op": "=", "val": "Finance"}] },
    "quality": { "score": 95.06, "inScopePct": 97.0, "outScopePct": 1.92 },
    "lifecycle": { "state": "proposed", "approvedAt": null, "implementedAt": null, "linkedRealRoleId": null }
  }
}
```

---

## What we explicitly decided NOT to support (yet)

- **Pre-computed candidate batches.** We don't store thousands of speculative candidates and let analysts browse them. Candidates exist only when the analyst saves one from an on-the-fly result.
- **Pre-computed baseline cohort tables.** Originally considered, then dropped once the implicit-complement contrastive metric was identified. Re-introduce only if/when an explicit comparison cohort feature is needed.
- **Auto-matching saved candidates to crawler-imported real roles.** Manual dropdown at `implemented` time for v1.
- **Plugin-owned candidate cache.** A plugin can precompute *support structures* in `prepare()`, not *answers*. Keeps the no-stale-candidates invariant intact.

---

## Open questions (pick up here)

1. **Plugin output contract — finalise field-by-field.** The sketch above is close, but the exact shape of `StructuredPredicate`, the `quality.metrics` schema, and whether `principalSets` should be IDs or lazy queries needs to be pinned down.

2. **Default ranker formula** when a plugin doesn't define its own score. Probably the contrastive score itself for v1 (since the default plugin is contrastive); the others define their own.

3. **Threshold for "show as candidate."** Score floor below which a resource doesn't appear as a column at all. The screenshot stops showing meaningful candidates somewhere around 85; a default floor of ~50 keeps the list meaningful when contrast is weak.

4. **Tie-breakers in the top-8 ranking.** Two candidates with near-identical scores — secondary sort by raw in-scope holder count avoids tiny-N rules floating up.

5. **LHS attribute allowlist.** For multi-attribute plugins (FP-Growth, trees), which principal attributes are eligible as LHS terms? Curated globally with per-plugin override? Where is the list configured?

6. **Latency budget hint vs async dispatch.** Stick with on-the-fly only for v1, or already design in the `prepare()` step? My recommendation: ship v1 with `compute()` only. Add `prepare()` the first time a heavy plugin needs it.

7. **What does "approve" do** beyond a state change? Generate an export artefact? Email the stakeholder? Just a button + audit log entry? Probably the last for v1.

8. **Detail-page contents.** The candidate detail subtab needs: rule predicate in plain English, plugin name, matrix scope at save time, quality metrics, the four principal lists (matchers / holders / gaps / extras), the lifecycle state machine, and the action buttons. Worth a quick wireframe before code.

9. **Where do plugins live in the repo?** `app/api/src/rule-mining/plugins/<plugin-name>/` mirrors the context-algorithm plugin layout. Confirm before scaffolding.

---

## References

- **Resource-cluster plugin** (the existing tokenization plugin we modelled the architecture on): `app/api/src/contexts/plugins/resource-cluster/tokenize.js`. Deterministic tokenizer + inverted index + frequency thresholds. See also `docs/architecture/resource-cluster-algorithm.md`.
- **Context redesign** (where the plugin pattern is described): `docs/architecture/context-redesign.md`, `docs/architecture/context-redesign-plan.md`.
- **Universal data model** (Resources / ResourceAssignments / ResourceRelationships): see CLAUDE.md sections 8 and 9 ("Universal Data Model" and "Universal Governance Model").
- **Matrix view** (where candidate columns will overlay): `app/ui/src/components/MatrixView.jsx` and `app/ui/src/components/matrix/`.
