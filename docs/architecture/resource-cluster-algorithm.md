# Resource-cluster algorithm

This document describes how the `resource-cluster` context-algorithm plugin
groups resources. The short answer: it's a **deterministic, rule-based
tokenizer + index**. No LLM calls, no embeddings, no probabilistic matching.

> **For the plugin framework itself**, see
> [context-redesign.md §4](context-redesign.md). For the 11-phase rollout
> plan, see [context-redesign-plan.md](context-redesign-plan.md).

---

## 1. What it does

Given the set of `Resources` in a system, the plugin produces one
generated `Context` per "significant token" that appears in ≥ N resource
names. A resource can belong to multiple clusters — a group named
`SG_APP_HAMIS_FINANCE_Admins_P` contributes to both a **HAMIS** cluster
and a **FINANCE** cluster (if both tokens clear the thresholds).

The plugin targets `Resource`, writes with `variant='generated'` and
`contextType='ResourceCluster'`, and attaches every cluster under a
synthetic root named by the `rootName` parameter (default
*"Resource Clusters"*).

## 2. When to use it

Use `resource-cluster` when:
- You want to quickly see which resources belong to the same app / system
  / business capability **based on naming conventions**.
- Your organisation uses consistent tokens (e.g. every HAMIS-related
  group has "HAMIS" somewhere in its name, even if the surrounding
  prefix/suffix varies).

Don't use it (and reach for [`business-process-llm`](context-redesign.md)
once it's wired up) when:
- Different systems use different names for the same concept
  (`Procurement` / `Inkoop` / `P2P` will not cluster together here).
- Names are opaque codes (`GRP00123`) where the token alone carries no
  meaning.

## 3. How it works

```
Resources  ─┐
            │  tokenize()         ↓ per-resource token list
            │  ── split on /[^a-zA-Z0-9]+/
            │  ── lowercase
            │  ── drop len < minTokenLength
            │  ── drop numerics
            │  ── drop stopwords  (role / env / type / filler / NL connectives
            │                      + user-supplied additionalStopwords)
            ▼
            Map<token, resourceId[]>
            │
            │  filter:
            │   • |resources| ≥ minMembers
            │   • |resources| ≤ total × maxTokenCoverage
            ▼
   one Context per surviving token
   one ContextMember per (token, resource) pair
```

Every step is pure data transformation. Same input → same output, every
run. One SQL query (`SELECT id, displayName FROM Resources WHERE
systemId = $1`) and then Node-side processing. Runs in milliseconds on
10 k resources.

### 3.1 Tokenizer detail

The tokenizer (`tokenize.js`) does five things in order:

1. **Lowercase** the input.
2. **Split** on any run of non-alphanumeric ASCII (`/[^a-zA-Z0-9]+/`).
   Hyphens, underscores, slashes, backslashes, whitespace, parentheses,
   brackets, commas, plus signs, ampersands, quotes — all treated as
   separators.
3. **Drop tokens** whose length is below `minTokenLength` (default 3).
4. **Drop purely numeric** tokens (`/^\d+$/`).
5. **Drop stopwords** — see §4.

### 3.2 Default stopword set

Four built-in categories, combined into a single `Set`:

| Category | Rationale | Example members |
|---|---|---|
| **Role / authority** | Not the thing of interest; distinguishes *who* has access rather than *to what*. Both EN + NL. | `admin`, `admins`, `user`, `users`, `owner`, `owners`, `reader`, `writer`, `viewer`, `manager`, `developer`, `support`, `approver`, `beheer`, `gebruikers`, `leden`, `eigenaar`, `eigenaren`, `bezoekers`, … |
| **Environment** | Clusters should unify across envs, not split by them. | `p`, `a`, `t`, `d`, `acc`, `tst`, `dev`, `prod`, `ont`, `stg`, `sbx`, `uat`, `qa`, … |
| **AD / type prefix** | Purely conventional; tells you what flavour of AD object, not what it's for. | `sg`, `dl`, `ag`, `sec`, `m365`, `aad`, `grp`, `group`, `team`, `app`, `apps`, `application`, … |
| **Filler** | Generic nouns that form noise clusters if kept. | `all`, `general`, `misc`, `role`, `roles`, `perm`, `permissions`, … |
| **NL connectives** | Clutter from descriptive Dutch display names. | `van`, `voor`, `naar`, `bij`, `aan`, `uit`, `over`, `met`, `als`, `door`, … (short ones like `de`, `en`, `op`, `te` fall out via `minTokenLength`) |

The full set lives in
[`tokenize.js`](../../app/api/src/contexts/plugins/resource-cluster/tokenize.js)
as `DEFAULT_STOPWORDS`. Tenant-specific additions go through the
`additionalStopwords` parameter.

### 3.3 Parameters

| Parameter | Default | Purpose |
|---|---|---|
| `scopeSystemId` | *null* | `Systems.id` — limit to one system. If omitted, runs across every Resource in every system. |
| `minMembers` | `4` | Drop clusters with fewer than this many resources. Lower → more clusters including noisy ones; higher → only strong signals. |
| `minTokenLength` | `3` | Tokens shorter than this are ignored. `3` drops `p`, `it`, and all single-letter tokens. |
| `maxTokenCoverage` | `0.7` | Reject tokens that appear in more than this fraction of resources (0..1). Filters out tokens so generic they would swallow the whole dataset. |
| `additionalStopwords` | `[]` | Extra tokens to ignore on top of the defaults. Lowercased at parse time. Use this for tenant-specific noise like `rol`, `azure`, `azuresubscription`. |
| `rootName` | `"Resource Clusters"` | Display name of the synthetic root that every cluster attaches under. |

## 4. Worked example

Input (an extract from a real Entra tenant):

```
SG_APP_HAMIS_Admins_P
GRP-HAMIS-ReadOnly-TST
AG_AzureDevOps_Hamis_Developer
AG_AzureSubscription_SCH_HaMIS_Polaris_Sandbox_Support
AG_AzureTeam_HaMIS_GedelegeerdProductOwner
AG_JITApprover_APP_HAMIS-ADAM_KCADMIN_A
SG_FINANCE_BookKeepers
DL_Finance_Readers
AG_ROL_DMS_Bezoekers van Finance-Commissie
```

After tokenisation (default stopwords, `minTokenLength=3`,
`additionalStopwords=["rol","azure","sch","adam","kcadmin","polaris","sandbox","gedelegeerdproductowner","commissie"]`):

| Resource | Surviving tokens |
|---|---|
| `SG_APP_HAMIS_Admins_P` | `hamis` |
| `GRP-HAMIS-ReadOnly-TST` | `hamis` |
| `AG_AzureDevOps_Hamis_Developer` | `devops`, `hamis` |
| `AG_AzureSubscription_SCH_HaMIS_Polaris_Sandbox_Support` | `hamis` |
| `AG_AzureTeam_HaMIS_GedelegeerdProductOwner` | `hamis` |
| `AG_JITApprover_APP_HAMIS-ADAM_KCADMIN_A` | `hamis`, `jitapprover` |
| `SG_FINANCE_BookKeepers` | `finance`, `bookkeepers` |
| `DL_Finance_Readers` | `finance` |
| `AG_ROL_DMS_Bezoekers van Finance-Commissie` | `dms`, `finance` |

Index built:

```
hamis        → 6 resources
finance      → 3 resources
devops       → 1 resource
jitapprover  → 1 resource
bookkeepers  → 1 resource
dms          → 1 resource
```

With `minMembers=4`, only the **HAMIS** cluster survives. With
`minMembers=3`, **HAMIS** and **FINANCE** both survive. With
`minMembers=1`, six clusters survive, most of them size-1 noise.

## 5. Real-data result

Running against one tenant's 9 683 resources with tuned stopwords
produced this top 10:

```
DMS                1890
Inkoop              788
Contractmanagement  773
SRV                 652
MGT                 433
SUB                 334
RDP                 310
RMA                 307
ORG                 227
IGA                 210
HAMIS               176   ← was 6 with the old stem-based algorithm
```

The same dataset with the previous stem-based algorithm produced 5
clusters (1 root + 4 stems), one of which was "app_hamis" at 6 members.
The token-based algorithm found 176 HAMIS-named resources — the ones
the stem stripper missed because they didn't match the fixed `(SG|DL|AG|…)_`
prefix whitelist.

## 6. Limitations

- **No fuzzy matching.** `HAMIS` and a typo'd `HMAIS` are different
  tokens. No edit-distance or phonetic coalescing.
- **No semantic grouping.** `Procurement` and `Inkoop` mean the same
  thing but form separate clusters.
- **Token order is ignored.** `finance_team` and `team_finance` are both
  `{finance, team}` — fine for this algorithm, but don't expect the
  order of tokens to matter.
- **Coverage cap is blunt.** A legitimate tenant-wide concept (say,
  every group starts with `Acme`) will be rejected if it clears 70 %
  coverage. Bump `maxTokenCoverage` in that case.
- **One-shot stopwords.** The default stopword set is a reasonable
  baseline but not exhaustive. Tune `additionalStopwords` per tenant;
  a common pattern is: run once, spot the junky top clusters (e.g.
  `ROL`, `VAN`, `AZURESUBSCRIPTION`), add them to
  `additionalStopwords`, re-run.

## 7. LLM vs rule-based clustering

Two plugins cover the same conceptual slot — clustering resources —
with different trade-offs:

| | **`resource-cluster`** | **`business-process-llm`** (stub) |
|---|---|---|
| Approach | Token index + stopwords | LLM assigns each resource to one of N analyst-supplied process descriptions |
| Latency | Milliseconds for 10 k rows | Seconds per batch; many batches for 10 k rows |
| Cost | Free | Per-token LLM cost |
| Deterministic? | Yes | No |
| Requires config | Reasonable defaults; tune stopwords per tenant | Analyst must describe each process in natural language |
| Handles synonyms | No | Yes |
| Handles typos | No | Usually |
| Handles opaque codes | Clusters by shared token; fails for pure codes | Better — LLM can infer meaning from context |

The intended workflow is both: run `resource-cluster` first for the
quick, cheap, explainable grouping; run `business-process-llm`
(once implemented) when you need to roll up semantically-related
resources that don't share a token.

## 8. Where the code lives

| File | Purpose |
|---|---|
| [`app/api/src/contexts/plugins/resource-cluster/index.js`](../../app/api/src/contexts/plugins/resource-cluster/index.js) | Plugin entry (`parametersSchema`, `run`) |
| [`app/api/src/contexts/plugins/resource-cluster/tokenize.js`](../../app/api/src/contexts/plugins/resource-cluster/tokenize.js) | Tokenizer + stopword set + `prettifyToken` |
| [`app/api/src/contexts/plugins/resource-cluster/tokenize.test.js`](../../app/api/src/contexts/plugins/resource-cluster/tokenize.test.js) | Unit tests for the tokenizer |
| [`app/api/src/contexts/plugins/resource-cluster/index.test.js`](../../app/api/src/contexts/plugins/resource-cluster/index.test.js) | Integration test for `run()` with a mocked db |
| [`app/api/src/contexts/plugins/runner.js`](../../app/api/src/contexts/plugins/runner.js) | Generic plugin runner (reconciler, member-count rollup) — not specific to this plugin |
