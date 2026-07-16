# Identity Atlas — Maintenance Sprint Audit
**Date:** 2026-06-25  **Branch:** main @ 5e88565  **Scope:** read-only audit, no code changes
**Phases:** Design/UX · Security · Performance & Code Quality · CI/Test Harness · Documentation

> Method: five parallel read-only audit agents, one per dimension, each producing
> file:line-evidenced findings. The five highest-impact claims were independently
> re-verified against source before publication (all confirmed). No new features —
> this is a maintenance/quality pass. Triage the backlog at the end into one-PR-at-a-time
> fixes (pentest-style), matching the existing UX-audit remediation pattern.

---

## Executive Summary

The codebase is in good health overall. Three of the five dimensions came back
"mature with specific, fixable defects" rather than "structurally broken":

- **Security posture is strong.** Correct JWT pinning, uniformly parameterized SQL
  with whitelisted identifiers, AES-256-GCM envelope encryption, re2 for all user/LLM
  regexes, real SSRF defense in the scraper. No *unauthenticated* exploit. The real
  authorization gaps are on the **crawler protocol** (a crawler key could claim any
  job and receive another system's vaulted secret) and a couple of ungated
  mutation endpoints — see SEC-NEW-2/3/4 (now fixed in PR #424). The read surface
  being open to any signed-in user (originally filed as SEC-NEW-1) turned out to be
  **intended design**, not a bug — corrected below.
- **The matrix data layer is well-engineered** — matviews, CONCURRENTLY refresh,
  pagination, row virtualization. Confirmed: the matview is declared-only, so
  crawlers must pre-materialize Indirect grants (the effectiveAccess engine is only
  folded in on opt-in). This matches your existing mental model.
- **CI is genuinely thoughtful** — dual PR gates, scope-aware path filters with safe
  fallback, SHA-pinned actions, aggregator gates for branch protection.

The themes worth a sprint:

1. **A bad global find/replace doubled every `dark:` utility** (`dark:text-gray-400
   dark:text-gray-500`), silently breaking dark mode across ~85 sites. Invisible in
   light mode, so it shipped. **Single highest value/effort fix in the whole audit.**
2. **Shared UI primitives exist but adoption isn't enforced** — no global Button/Modal,
   competing lime/indigo accents vs the documented "blue only" rule, axe suite skipped
   wholesale.
3. **The E2E safety net is off** — Playwright job is `continue-on-error: true`, visual
   regression skipped with no baselines, secret-dependent tests skip silently (false green).
4. **A real data bug** in identity detail (`userId`/`principalId` key mismatch) — group
   counts always 0, risk never attaches.
5. **Doc drift on the flagship concept doc** — `data-model.md` and `risk-scoring-model.md`
   still describe dropped tables (`GraphResourceClusters`, per-entity `contextId`); the
   OpenAPI spec covers ~22 of 100+ routes; the new soft-delete lifecycle is undocumented.

**Finding counts:** Design 21 · Security 19 · Perf/Quality 20 · CI 13 · Docs 12 = **85 total.**
Critical/High across all dimensions: **14.**

---

## Remediation Status

_Status tracking added 2026-07-14. In the weeks since this audit the backlog was worked one PR at a time; the tables below record where each finding landed, matching the Status convention of the [Security Assessment](assessment.md) and [UX Assessment](../ux/assessment.md) pages. The detailed phase sections that follow are the original audit text, unchanged._

Status legend: ✅ **Fixed** (merged) · 🟦 **By design** (intended/supported, documented) · 🟨 **Partially addressed** · 🔧 **Open**.

| Phase | Tracked | ✅ Fixed | 🟦 By design | 🟨 Partial | 🔧 Open |
|-------|--------:|--------:|------------:|----------:|--------:|
| Design / UX | 21 | 5 | 0 | 1 | 15 |
| Security | 22 | 10 | 2 | 1 | 9 |
| Perf & Quality | 16 | 5 | 2 | 3 | 6 |
| CI / Test Harness | 11 | 6 | 0 | 3 | 2 |
| Documentation | 11 | 9 | 0 | 1 | 1 |
| **Total** | **81** | **35** | **4** | **9** | **33** |

_(Row groups P6–P10, Q9–Q10, F10–F13, D10–D12 and the Codex net-new bullets are tracked as single rows here; the audit's raw sub-finding count is 85.)_

All **Critical** findings are fixed and merged. Every exploitable **security** finding is closed — the Bicep secret leak (H-1), the crawler-protocol authorization gaps (SEC-NEW-2/3/4), and the LLM SSRF / timeout / prompt-injection hardening — as are the correctness and perf headliners (the P1 identity-detail data bug, the Q1 matrix god-module split, the P3 covering index) and the CI safety-net gaps (E2E now blocks merges, enforced coverage floors, workflow concurrency). The remaining open items are concentrated in **Design** High/Medium/Low UI-consistency & a11y polish (shared Button/Modal, accent sweep, list-page error states), **security Low-tier** infrastructure hardening, and the **large-effort perf refactors** (flat-grid pagination, matrix column virtualization).

### Design / UX
| ID | Status | PR / evidence |
|----|--------|---------------|
| C1 | ✅ Fixed | #427 + `no-duplicate-dark-color` ESLint rule (strips + blocks doubled `dark:`) |
| C2 | ✅ Fixed | #427 |
| C3 | ✅ Fixed | #525 — axe suite re-armed across all nav tabs |
| H1 | 🔧 Open | accent sprawl (lime/indigo vs blue) not yet unified |
| H2 | 🔧 Open | no shared `components/Button.jsx` |
| H3 | 🔧 Open | clickable non-controls (`<tr>`/`<span>`) remain |
| H4 | 🔧 Open | modal Escape/focus-trap/`role="dialog"` not added |
| H5 | 🔧 Open | 6 modal overlays not consolidated |
| H6 | 🔧 Open | `useEntityPage` still has no error state |
| M1 | 🔧 Open | duplicate `Section`/`StatCard` remain |
| M2 | ✅ Fixed | #500 — `DialogProvider` + `no-native-dialogs` rule |
| M3 | 🔧 Open | emoji-as-icon persists |
| M4 | 🔧 Open | Dashboard StatCard gradients remain |
| M5 | 🔧 Open | radius scale unstandardized |
| M6 | ✅ Fixed | #427 (same codemod + lint rule as C1) |
| M7 | 🔧 Open | tables lack `overflow-x-auto` |
| M8 | 🔧 Open | tag-pill `color + '20'` alpha hack remains |
| L1 | 🔧 Open | list pages don't use shared `EmptyState` |
| L2 | 🟨 Partially addressed | #525 added aria-labels on nav pages; search inputs still placeholder-only |
| L3 | 🔧 Open | no semantic design-token layer |
| L4 | 🔧 Open | active tab still near-black, not blue |

### Security
| ID | Status | PR / evidence |
|----|--------|---------------|
| H-1 | ✅ Fixed | #475 — keys removed from Bicep outputs (key rotation is an operational follow-up) |
| M-1 | ✅ Fixed | #484 — LLM fetch AbortController timeout + body-size cap |
| M-2 | ✅ Fixed | #484 / #582 — stop returning upstream error bodies to clients |
| M-3 | ✅ Fixed | #488 — `redirect:'manual'` on LLM fetches |
| M-4 | 🔧 Open | upload per-file / aggregate caps unchanged |
| M-5 | ✅ Fixed | #488 — untrusted scraped-content fencing |
| M-6 | ✅ Fixed | #488 — RE2 classifier-pattern validation on save |
| L-1 | 🔧 Open | cron command still `Invoke-Expression` |
| L-2 | 🔧 Open | plaintext secret temp file written without perms |
| L-3 | 🔧 Open | full job transcript to shared volume |
| L-4 | 🔧 Open | Azure data services still public; no Isolated/private-endpoint template |
| L-5 | 🔧 Open | Postgres password still deterministically derived |
| L-6 | 🟨 Partially addressed | http/https scheme check added (omada/midpoint); no host/private-IP allowlist |
| L-7 | 🔧 Open | `PGSSLMODE=require`, not `verify-full` |
| L-8 | 🔧 Open | CSV parser still buffers whole file, no row cap |
| I-1 | ✅ Fixed | #682 — allow-listed table + Postgres identifier quoting (displayName no longer null) |
| I-2 | 🔧 Open | stale contradictory IaC comments remain |
| SEC-NEW-1 | 🟦 By design | open read surface is intended (`data.read` IMPLICIT); documented + tested |
| SEC-NEW-2 | ✅ Fixed | #424 — job-claim/secret-inject restricted to the worker key |
| SEC-NEW-3 | ✅ Fixed | #424 — `crawlerHasSystemAccess` on delta-token endpoints |
| SEC-NEW-4 | ✅ Fixed | #424 — perf clear/toggle gated behind an admin permission |
| SEC-NEW-5 | 🟦 By design | shared org-wide saved filters (migration 023 documents it) |

### Perf & Quality
| ID | Status | PR / evidence |
|----|--------|---------------|
| P1 | ✅ Fixed | #634 / #651 — `enrichMembers` keys by `principalId` |
| P2 | 🔧 Open | flat grid still caps at 400k→413; no cursor/keyset pagination |
| P3 | ✅ Fixed | migration 042 — partial covering index on the matview |
| P4 | 🔧 Open | matrix columns still not virtualized |
| P5 | 🔧 Open | every sync still does a full matview refresh |
| P6–P10 | 🟦 By design | mostly non-issues (perf-mw off, UNION cached); one trivial await remains |
| Q1 | ✅ Fixed | #634 / #651 / #543 — matrix god-module split into handlers |
| Q2 | ✅ Fixed | #474 — catch-as-feature-detection replaced by `db/schemaErrors.js` |
| Q3 | 🔧 Open | `runBound` helper not created (bind-loops remain) |
| Q4 | 🟨 Partially addressed | per-folder `shared.js` de-dup; `resources.js` still duplicates helpers |
| Q5 | 🟨 Partially addressed | resource-map logic consolidated; no explicit `resourceFromRow` helper |
| Q6 | 🔧 Open | two runtime `CREATE TABLE` DDLs remain (migration 023 owns them) |
| Q7 | ✅ Fixed | #678 / #667 — dead GraphUsers/GraphGroups fallbacks removed |
| Q8 | 🟦 By design | positive finding — TODO/FIXME density stayed ~zero |
| Q9–Q10 | ✅ Fixed | #811 dropped the redundant jsonb parse (`lib/jsonb.js`); #812 centralized `#microsoft.graph.group` into `lib/principalTypes.js` (`400_000` was already `MAX_FLAT_ROWS`) |
| Codex perf | 🟨 Partially addressed | riskScores top-N `LIMIT` fixed (#660); unpaginated group/assignment endpoints + MatrixView nested loop remain |

### CI / Test Harness
| ID | Status | PR / evidence |
|----|--------|---------------|
| F1 | ✅ Fixed | #437 — core E2E now blocks the PR |
| F2 | 🔧 Open | secret-dependent tests still skip silently (no assert-secrets gate) |
| F3 | ✅ Fixed | #655 — dead visual-regression suite removed (resolves the false-green) |
| F4 | ✅ Fixed | #428 — `concurrency: cancel-in-progress` on both PR workflows |
| F5 | ✅ Fixed | #584 / #652 / #615 / #622 — coverage floors + per-file & diff ratchets + Pester floor |
| F6 | 🔧 Open | `test/ci-scripts/*.sh` self-tests still unwired to any workflow |
| F7 | ✅ Fixed | #428 — API ESLint now runs on API-only PRs |
| F8 | ✅ Fixed | mocked Pester units now cover every crawler (+ #622 floor) |
| F9 | 🟨 Partially addressed | PSScriptAnalyzer added; Python still absent from CodeQL |
| F10–F13 | 🟨 Partially addressed | cut-hotfix SHA-pinned; bump-version rebase-retry + build-once still open |
| Codex CI | 🟨 Partially addressed | #428 closed config path-filter gaps; `test/nightly` filter, skip-label bypasses, a fixed-sleep flake remain |

### Documentation
| ID | Status | PR / evidence |
|----|--------|---------------|
| D1 | ✅ Fixed | #491 — OpenAPI explicitly scoped + cross-links the read API |
| D2 | ✅ Fixed | #491 — dropped cluster tables removed; documented as a plugin |
| D3 | ✅ Fixed | #489 — `/api/org-units` replaced with Contexts |
| D4 | ✅ Fixed | #497 — soft-delete lifecycle page added |
| D5 | ✅ Fixed | #491 — nav orphans added to `mkdocs.yml` |
| D6 | ✅ Fixed | #489 — "Azure SQL"→PostgreSQL; tags noted as views |
| D7 | ✅ Fixed | #489 — data-model version label aligned to v3.1 |
| D8 | ✅ Fixed | #491 — init order reconciled with migration-created tables |
| D9 | ✅ Fixed | #496 — data-model Contexts section rewritten to the ContextMembers model |
| D10–D12 | 🟨 Partially addressed | #489 (README name + history-column example fixed); `.spectral.yaml` still thin |
| Codex docs | 🔧 Open | `entities.md` still cites `mat_UserPermissionAssignments` + `/api/perf/slowest`; the risk-scoring-model SQL-Server types are fixed in-flight in #690 |

---

## Phase 1 — Design / UX (React 19 UI)

**Summary:** The UI has matured — a real shared layer now exists (`Stepper`, `EmptyState`,
`DetailSection`, `inputs/*`, `ModalPrimitives`, token files). The old duplicated-Stepper
finding is resolved. What remains: inconsistent adoption of those primitives + a systemic
copy-paste dark-mode bug.

### Critical
| ID | Area | Location | Issue | Fix | Effort |
|----|------|----------|-------|-----|--------|
| C1 | Dark mode | 59 sites / 8 files (ContextDetailPage 16×, RiskScoringPage 26×, RunDetailPage 7×, ModalPrimitives 3×, ContextsPage 3×, …) | Doubled `dark:text-gray-400 dark:text-gray-500` — Tailwind keeps the *last* class, so secondary text is silently downgraded to lower-contrast gray-500 in dark mode. **Verified: 59 occurrences.** | Codemod-strip the trailing redundant `dark:text-gray-500`; add ESLint rule flagging duplicate `dark:` utilities of the same property | M |
| C2 | Dark mode | 9 sites / 5 files (RiskScoringPage:127, ContextDetailPage:331, ModalPrimitives:69, …) | Doubled `hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:bg-gray-700/50` — the stray non-hover class makes rows/buttons look *permanently* hovered in dark mode | Remove the non-hover `dark:bg-gray-700/50` | S |
| C3 | A11y | `e2e/accessibility.spec.js:19-29` | The entire axe-core WCAG 2a/2aa suite is `test.skip()`; only the skip-link test runs. Comment admits color-contrast + missing input labels deferred indefinitely | Re-enable axe on Users/Resources first, fix labels + lime contrast, gate in CI | M |

### High
| ID | Area | Location | Issue | Fix | Effort |
|----|------|----------|-------|-----|--------|
| H1 | Consistency | DashboardPage (27 lime), AuthSettingsPage (8 indigo), RollupMatrixView (13 teal) vs blue elsewhere | 3+ competing accent families, contradicting the documented "blue is the single interactive accent" rule (Stepper.jsx:2) | Blue = the one interactive accent; demote lime to brand/illustration; convert indigo links to blue | M |
| H2 | Duplication | No `Button.jsx`; 30 inline primary-button strings / 16 files. `PrimaryButton`/`SecondaryButton` exist but are trapped in `contexts/ModalPrimitives.jsx` | Promote to `components/Button.jsx` with variant/size; codemod call sites | L |
| H3 | A11y | GroupsPage:57-83/263-300, DashboardPage:310 (StatCard) | Clickable `<span>`/`<tr>`/`<div>` with no role/tabIndex/keyboard handler — unreachable by keyboard | Use real `<button>`/`<a>` or add role+tabIndex+onKeyDown | M |
| H4 | A11y | All 6 modals (ModalPrimitives:9, CrawlersPage:393, MatrixView:1127, MatrixFilterWizard:1142, RiskScoringPage:267, RiskProfileWizard:574) | No modal closes on Escape, traps focus, or sets `role="dialog"`/`aria-modal` (grep: zero Escape matches in any overlay) | Shared `Modal` with role/aria + Escape + focus trap; route all 6 through it | M |
| H5 | Duplication | 6 distinct modal overlays; CrawlersPage:393 uses deprecated `bg-opacity-50` with no dark variant | Consolidate onto one Modal; `bg-opacity-50`→`bg-black/50` | M |
| H6 | States | `hooks/useEntityPage.js:67/77/110` | List pages have **no error state** — fetch failures swallowed to console.error, so a failed load shows the *empty* message ("No resources found"), indistinguishable from genuinely empty | Add `error` state to the hook; render distinct error panel with retry | M |

### Medium / Low (condensed)
- **M1** 4 redundant `Section` + 2 `StatCard` redefinitions despite shared `DetailSection`.
- **M2** No toast system — 9 native `alert()`/`confirm()` (jarring, no dark mode).
- **M3** Emoji-as-icon (AdminPage 🏢🎯📊📦) mixed with inline svg + unicode glyphs.
- **M4** Gradient overuse on Dashboard StatCards only. **M5** Radius scale unstandardized (`rounded`/`rounded-lg`/`rounded-xl`). **M6** No-op hover colors (same find/replace as C1). **M7** Data tables lack `overflow-x-auto` (crush on narrow screens). **M8** Tag-pill inline `color + '20'` alpha hack risks contrast failures.
- **L1** List pages dead-end with bare text instead of shared `EmptyState`. **L2** Inputs lack labels/aria. **L3** No semantic design-token layer in `index.css` (root enabler of C1/C2/H1). **L4** RiskScoringPage active-tab uses near-black not blue.

**Root causes:** (1) a bad global find/replace doubled every `dark:` class (~85 defects, C1/C2/M6); (2) shared primitives exist but adoption isn't lint-enforced or folder-global; (3) no semantic design-token layer; (4) a11y treated as deferrable (axe skipped).

---

## Phase 2 — Security (authorized defensive review)

**Summary:** Mature defense-in-depth, with inline evidence of prior security review
(fixed C-01/H-01/H-08). Fail-closed authz, correct JWT aud/iss/alg/tenant pinning,
uniformly parameterized SQL with `SAFE_IDENT_RE` whitelists + information_schema-sourced
identifiers (no injection across ~40 interpolation sites), AES-256-GCM envelope encryption,
re2 for all regexes, DNS-pinned redirect-revalidating scraper. **No unauthenticated- or
low-priv-reachable exploit found.** Findings are mostly hardening + one real IaC leak.

### High
| ID | Category | Location | Issue | Fix | Effort |
|----|----------|----------|-------|-----|--------|
| H-1 | A05 / Secrets | `azure/modules/storage.bicep:59`, `log-analytics.bicep:62` | Storage account key + LA shared key emitted as Bicep **outputs** (linter rule suppressed). Outputs persist in ARM deployment history, readable by any RG/deployment-reader → full file-share data-plane access. **Verified.** | Don't cross a module boundary with secrets; consumers call `listKeys()` directly. Rotate keys. | M |

### Medium
| ID | Category | Location | Issue | Fix | Effort |
|----|----------|----------|-------|-----|--------|
| M-1 | A06 / Availability | `llm/providers.js:59,100,142,254,312,336` | No timeout/AbortSignal on any outbound LLM fetch; no response-size cap. A hung provider holds the request open indefinitely | AbortController timeout + body-size cap on all provider fetches | S |
| M-2 | A09 / Info leak | `routes/llm.js:64,105,108,126`, `riskProfiles.js:86,155,211,403` | Upstream provider error bodies returned to client via `err.message`, violating the project's own "generic messages to clients" rule | Log server-side; return generic error | S |
| M-3 | A04 / SSRF residual | `llm/providers.js:142-147` | Azure path uses fetch (auto-follows redirects) with custom `api-key` header allowlisted only on the initial request; redirect to internal addr could carry the key | `redirect:'manual'` + revalidate, as the scraper already does | S |
| M-4 | A04 / DoS | `routes/crawlerFiles.js:96-101,150` | Upload limits 1 GB × 50 files = ~50 GB/request to a shared Docker volume; no aggregate cap (admin-only) | Lower per-file cap (100-250 MB) + aggregate cap | S |
| M-5 | A03 / Prompt injection | `llm/scraper.js:250-253` → `riskPrompts.js:66-69` | Scraped page content + user hints interpolated verbatim into prompt; can coax a hostile classifier regex (admin reviews output, low blast radius) | Delimit/encode external content; validate LLM-authored regexes on save | M |
| M-6 | A03 / ReDoS (verify) | `routes/riskProfiles.js:408` | LLM/admin-authored classifier patterns stored unvalidated. Mitigated **iff** every exec path uses re2 (appears true) | Confirm all pattern exec uses re2; add save-time validation | S |

### Low / Info (condensed)
- **L-1** `setup/docker/scheduler.ps1:198` `Invoke-Expression $cron.Command` (operator-supplied crontab, not network-reachable; classic IEX anti-pattern → allowlist dispatch).
- **L-2** Plaintext clientSecret to `GetTempFileName()` without explicit perms (entra-id/Invoke-CrawlerJob; chmod 600 or stdin).
- **L-3** Full job transcript to shared volume (latent secret-leak if future debug line echoes config).
- **L-4** Azure data services publicly reachable (KV/Postgres/Storage — documented "Simple shape" tradeoff; ship Isolated/private-endpoint template).
- **L-5** Postgres admin password deterministically derived from `uniqueString(RG id)` — formula is in the public repo (random KV-only secret instead).
- **L-6** Connector base URLs (Omada/OData/midPoint) have no scheme allowlist (admin could point at metadata endpoint with bearer).
- **L-7** `PGSSLMODE=require` (not `verify-full`) — doesn't stop active MITM.
- **L-8** CSV file parser loads whole file into memory, no row cap (pairs with L-2 1 GB upload → worker OOM).
- **I-1** `riskScores.js:595` interpolates the literal string `"tableName"` + MSSQL bracket syntax on Postgres → query always throws (swallowed), `displayName` always null. Latent bug, not injection.
- **I-2** Stale IaC comments ("RBAC-only" vs access-policies; "OPEN mode" vs `AUTH_ENABLED=true`).

**Confirmed exploitable:** only H-1 (RG-reader → storage key). Everything else needs
elevated app privilege, a compromised upstream, or host/deploy access.

**Top 5:** H-1 (remove secrets from Bicep outputs + rotate) → M-1 (LLM fetch timeouts) →
M-2 (stop leaking error bodies) → M-4/L-8 (upload + CSV bounds) → L-4/L-5 (Isolated Azure template, random DB password).

---

## Phase 3 — Performance & Code Quality

**Summary:** Matrix data layer is well-engineered (matviews, CONCURRENTLY refresh,
pagination, row virtualization). Known-context confirmed: matview is declared-only, so
Indirect grants are pre-materialized by crawlers; effectiveAccess engine folded in only on
opt-in bounded-scope requests. Biggest correctness issue is a real data bug; biggest
quality issues are the 1,720-line `matrix.js` god-module and `catch {}`-as-feature-detection.

### Performance
| ID | Sev | Location | Issue | Impact | Fix | Effort |
|----|-----|----------|-------|--------|-----|--------|
| P1 | High | `routes/identities.js:316-348` | Risk + group-count maps keyed/read by `.userId`, but SQL selects `principalId` (never selects userId). **Verified.** | 2 extra round-trips per identity-detail page silently discarded; group counts always 0, risk never attaches | Key maps by `principalId`, read `member.principalId` | S |
| P2 | High | `routes/matrix.js:1404-1521` | Flat `/matrix/data` ships full cross-product as one JSON array up to MAX_FLAT_ROWS=400k, no server pagination; >500k hits V8 `Invalid string length` | Large tenants get 413 instead of data; huge responses = heavy GC on event loop | Cursor/keyset pagination for flat grid, or steer to aggregated views earlier | L |
| P3 | High | migration 041 indexes vs `matrix.js` rollup/scope queries | Matview indexed only on PK + single-col; hot queries filter `membershipType='Direct' AND principalType != group` (principalType unindexed) on a ~1.5M-row matview | Rollup/scope-stat queries do bitmap/seq scans | Partial covering index `(resourceId,principalId) WHERE membershipType='Direct'` | M |
| P4 | Med | `MatrixView.jsx:966-1098`, `SortableMatrixBody.jsx:79-143` | Only rows virtualized; columns are not — every resource column renders a `<td>` per visible row | Wide matrices (100s of columns) = huge DOM, slow scroll | Add column virtualization or cap visible columns | L |
| P5 | Med | `routes/ingest.js:476-518` | Every `refresh-views` does 2 `REFRESH MATERIALIZED VIEW CONCURRENTLY` + ANALYZE×13 at end of every CSV sync; matview has 2 NOT EXISTS soft-delete subqueries | Multi-second-to-minute recompute per sync on large tenants | Incremental/conditional refresh; index-support the soft-delete NOT EXISTS | M |
| P6-P10 | Low-Med | (see detail) | Identity-column UNION-ALL cost (cached, ok); ingest uses INSERT not COPY (stale header comment); excel buffered in memory (tiny today); perf middleware correctly off-by-default (good); `getPermissionTable()` pointless await of a constant | — | mostly minor / doc fixes | S |

### Code Quality
| ID | Sev | Location | Issue | Fix | Effort |
|----|-----|----------|-------|-----|--------|
| Q1 | High | `routes/matrix.js` (1,720 lines) | God-module: 8 SQL builders + 8 handlers + saved-filters CRUD; `/matrix/data` handler alone ~715 lines, 5 nested branches | Split into `matrix/handlers/{flat,rollup,context,fold}.js` | L |
| Q2 | High | API-wide (details.js ~20 blocks, identities.js) | `try {…} catch {}` used as schema-version feature-detection on the hot path — masks real bugs (P1 would've been caught) and adds per-request branch cost | Detect schema once at startup (capability map); let real errors surface | M |
| Q3 | Med | `matrix.js` (~20 sites) | Bind-loop `for (…) req.input(k,v)` copy-pasted ~20× | Generalize the existing `runCount` into `runBound(...)` | S |
| Q4 | Med | details/resources/identities.js | Duplicated helpers: `cleanRow`, `parseTags` (already drifted — one parseInts id, other keeps string), `UUID_RE` ×6, `getPermissionTable` ×2 | Extract to `routes/_shared.js` | S |
| Q5 | Med | `matrix.js` (5+ sites) | resource-map build loop repeated verbatim 5× | Extract `resourceFromRow()`/`collectResources()` | S |
| Q6 | Med | `ingest.js:539`, `matrix.js:1578` | `SavedMatrixFilters` DDL duplicated at runtime (different defaults), violating "schema via migrations only" — migration 023 already creates it | Delete both runtime DDLs | S |
| Q7 | Med | details.js:716-757, identities.js | Dead legacy GraphGroups/GraphUsers fallbacks for a schema that no longer exists (can never succeed, add latency on failure) + bug-narrative comment blocks | Delete legacy fallbacks | M |
| Q8 | Low | repo-wide | **Positive:** TODO/FIXME/HACK density effectively zero in app/src | — | — |
| Q9-Q10 | Low | extendedAttributes `JSON.parse` on already-parsed jsonb (throws, swallowed); magic strings (`#microsoft.graph.group`, `400_000`) scattered | Drop the parse; centralize constants | S |

**Biggest offenders:** matrix.js (1,720) · AdminPage.jsx (1,726) / MatrixFilterWizard (1,232) / MatrixView (1,178) · Start-EntraIDCrawler.ps1 (2,453) · details.js (907) · identities.js (696).

**Top 5:** P1 (the data bug) → P3 (partial covering index) → Q2 (stop catch-as-feature-detection) → Q1/Q3/Q5 (split matrix.js + de-dup) → P4 (column virtualization).

---

## Phase 4 — CI / Test Harness

**Summary:** Strong harness — dual PR gates (`pr.yml` fast + `pr-integration.yml` full
Docker stack), scope-aware path filters with safe fallback-to-run-all, single aggregator
gates for branch protection, SHA-pinned actions. Biggest reliability risk: the E2E job is
non-blocking, so every UI regression it could catch is advisory. Biggest correctness risk:
secret-dependent tests skip silently (false green). No JS coverage thresholds anywhere.

| ID | Sev | Location | Issue | Fix | Effort |
|----|-----|----------|-------|-----|--------|
| F1 | High | `pr-integration.yml:678` | **All E2E non-blocking** (`continue-on-error: true`) — 21 specs + axe + visual never fail CI. **Verified.** | Triage into blocking core set + quarantined set; drop continue-on-error for the core | M |
| F2 | High | `pr-integration.yml:408,483` | Secret-dependent tests (Entra, LLM) skip silently when secrets unset → register green having run nothing | Assert required secrets exist on main PRs (visible gate) | S |
| F3 | High | `visual-regression.spec.js:17` | Visual regression `test.skip`'d, no baselines committed; CI also `--ignore-snapshots` | Generate+commit chromium-linux baselines; un-skip; drop --ignore-snapshots | M |
| F4 | High | pr.yml, pr-integration.yml | No `concurrency` block on either PR workflow — stale runs not cancelled (wasted Docker/load-soak minutes, out-of-order gates) | Add `concurrency: {group: ci-${{github.ref}}, cancel-in-progress: true}` | S |
| F5 | Med | api/ui package.json | JS tests run `vitest run` with no `--coverage`/threshold; Pester prints coverage but never enforces | Add `--coverage` with ratcheting threshold; Pester floor | M |
| F6 | Med | `test/ci-scripts/*.sh` | The path-gate self-tests (deciding *what CI runs*) aren't run by any workflow | Add a tiny PR job running the 3 self-test scripts | S |
| F7 | Med | `pr.yml:225-231` | API ESLint (carries the security rules) only runs under **ui** scope — an API-only PR skips API linting | Split API eslint into its own `api`-scoped job | S |
| F8 | Med | test/unit, tools/crawlers | 30 crawler .ps1 files; few have mocked Pester unit tests — most verified only via live-stack integration needing Docker + secrets | Add mocked-Graph/REST Pester units for parsing/transform/paging | L |
| F9 | Med | `codeql.yml:26` | Only javascript-typescript analyzed — PowerShell worker + Python helpers get no SAST | Add python to CodeQL; enable PSScriptAnalyzer security rules | S |
| F10-F13 | Low | cut-hotfix.yml:68 floating `@v6` tag (others SHA-pinned); thin vault/softDelete tests; bump-version push lacks rebase-retry (race with sbom-update); 3 jobs each rebuild Docker images | pin SHA; add negative-path tests; add retry loop; build-once artifact | S-M |

**Critical-path coverage:** auth/JWT/permissions **strong** (but the whole CI stack runs
`AUTH_ENABLED=false` — the real auth gate is never exercised end-to-end). Matrix SQL
**good.** Ingest soft-delete **good.** Secrets vault **partial** (happy-path only).
**Gaps:** no auth-enabled flow in CI; most PowerShell crawlers lack mocked units; visual/a11y written but non-blocking.

**Top 5:** F1 (make core E2E blocking) + F3 (commit visual baselines) → F2 (fail on missing secrets) → F4 (concurrency) → F6+F7 (wire ci-scripts, fix eslint scoping) → F5 (coverage thresholds).

---

## Phase 5 — Documentation

**Summary:** Moderate-to-good on concepts, weak on API-reference completeness and nav
hygiene. Core architecture docs largely track the v6 Contexts redesign and the Azure
Resource Graph crawler (#420). The previously-feared "stale OrgUnits" concern is mostly a
**false alarm** — OrgUnit now correctly appears only as a `contextType` value. Real issues:

| ID | Sev | Type | Location | Issue | Fix | Effort |
|----|-----|------|----------|-------|-----|--------|
| D1 | Critical | Gap | `app/api/src/openapi.yaml` | Spec covers ~22 ingest/crawler-admin paths; the entire authenticated read API (matrix, identities, resources, governance, risk-scores, contexts, details, org-chart, tags, account-linking — 100+ routes) is absent | Generate read routes into the spec, OR explicitly scope it "Ingest + Crawler Admin" and cross-link docs/api/* | L |
| D2 | High | Stale | `docs/concepts/risk-scoring-model.md` (25-28, 71-91, 192-227) | Documents `GraphResourceClusters`/`GraphResourceClusterMembers` as live; migration 019 dropped them (clustering is now the resource-cluster context plugin). **Verified.** | Remove cluster-table sections + `Save-FGResourceClusters` init step; point to the plugin | M |
| D3 | High | Stale | `docs/api/index.md:68` | Lists `/api/org-units` as a live endpoint group — route doesn't exist (org hierarchy is `/api/contexts/tree` + `/api/org-chart`) | Replace with Contexts | S |
| D4 | High | Gap | docs/ (soft-delete) | The soft-delete/tombstone lifecycle (migrations 040/041, #400/#401 — headline of recent commits) has no dedicated doc; only 2 passing mentions | Add a concepts/operations page: re-activation, retention/purge job, "show deleted" toggle, matrix exclusion | M |
| D5 | High | Broken | `mkdocs.yml` nav | 15 orphan docs not in nav, incl. the context-redesign trilogy and `effective-access-engine.md` (which other docs link to) | Add user-facing ones to nav; move/mark internal planning docs | M |
| D6 | Med | Stale | docs/api/index.md, entities/governance/matrix.md | References "Azure SQL" (it's PostgreSQL) and `GraphTags`/`GraphTagAssignments` as base tables (they're backward-compat views over Contexts) | Fix DB name; note tags are views | M |
| D7 | Med | Inconsistent | data-model.md:3 (v3.2) vs CLAUDE.md:93 (v3.1) | Data-model version label drift | Align to one version | S |
| D8 | Med | Stale | risk-scoring-model.md:232-247 | Init-order uses `Initialize-FGRiskScoreTables`/`Save-FGResourceClusters` cmdlets, contradicting line 8 ("created by migration 004 at startup") | Reconcile init steps | S |
| D9 | Low→High* | Inconsistent | `data-model.md` (whole) vs migration 018 | Flagship doc still models per-entity `contextId` columns + `Identities.contextId` FK in the ERD; migration 018 dropped all three, membership moved to `ContextMembers`. *Most significant accuracy drift in the flagship concept doc* | Rewrite Contexts section to describe ContextMembers variant/targetType model | L |
| D10-D12 | Low | misc | README legacy "(FortigiGraph)" name + verify `tools/powershell-sdk/` path; `.spectral.yaml` only `spectral:oas` (thin spec passes trivially); history example uses SQL-Server `SysStartTime`/`SysEndTime` not `_history`/`changedAt` | minor edits | S |

**Missing docs:** soft-delete lifecycle (D4); read API in OpenAPI (D1); effective-access
engine (exists but orphaned, D5); secrets/vault (only incidental mentions).

**Top 5:** D1 (OpenAPI scope decision) → D2 (remove dropped cluster tables) → D9 (rewrite
Contexts section of data-model.md) → D4 (document soft-delete) → D5 (fix nav orphans).

---

## Cross-Cutting Themes (flagged in 2+ phases independently)

1. **`catch {}` as schema feature-detection** — Perf/Quality flags it as a maintainability +
   silent-bug hazard (Q2); it's the *direct cause* of the identities.js data bug (P1) staying
   hidden. The same swallow-pattern in the UI (H6, fetch errors → console.error) makes failed
   loads look empty. **One discipline change fixes a class of bugs across API + UI.**
2. **Deferred-then-forgotten quality gates** — the axe a11y suite (C3), visual regression
   (F3), and the whole E2E job (F1) are all written but switched off. The safety nets exist;
   they're just not armed.
3. **Doc/code drift concentrated around the two big recent migrations** — the v6 Contexts
   redesign (018/019/020) and soft-delete (040/041). Docs lag exactly where the schema moved
   fastest (D2, D4, D9).
4. **"Reuse before creating" is documented but not enforced** — shows up as UI primitive
   duplication (H2, H5, M1) and API helper duplication (Q4, Q5, Q6). Lint rules would hold the line.

---

## Prioritized Backlog (suggested one-PR-at-a-time slices)

Ordered by value/effort. Each row = a candidate branch. Effort is CC-time (S≈<1h, M≈half-day, L≈1-2 days).

### Tier 1 — High value, low effort (do first)
| # | PR slice | Fixes | Effort |
|---|----------|-------|--------|
| 1 | **Codemod-strip duplicated `dark:` classes** + add ESLint rule | C1, C2, M6 (~85 dark-mode defects) | S |
| 2 | **Fix identities.js `userId`→`principalId` key bug** | P1 (group counts, risk attach) | S |
| 3 | **Remove secrets from Bicep outputs + rotate keys** | H-1 | M |
| 4 | **Add `concurrency` cancel-in-progress to both PR workflows** | F4 | S |
| 5 | **Fail CI when required test secrets missing on main PRs** | F2 | S |
| 6 | **Fix API-eslint scoping + wire ci-scripts self-tests** | F6, F7 | S |
| 7 | **LLM fetch timeouts + stop leaking error bodies** | M-1, M-2 | S |
| 8 | **Tighten upload + CSV row bounds** | M-4, L-8 | S |
| 9 | **Doc drift quick fixes:** drop `/api/org-units`, "Azure SQL"→PostgreSQL, version label, history-column example | D3, D6, D7, D12 | S |
| 10 | **Remove dropped cluster tables from risk-scoring-model.md** | D2, D8 | S-M |

### Tier 2 — High value, medium effort
| # | PR slice | Fixes | Effort |
|---|----------|-------|--------|
| 11 | **Make core E2E blocking + commit visual baselines** | F1, F3 | M |
| 12 | **Re-enable axe on Users/Resources + fix input labels & lime contrast** | C3, L2, H1(partial) | M |
| 13 | **Add partial covering index on matrix matview** | P3 | M |
| 14 | **Shared error state in useEntityPage + distinct error panels** | H6 | M |
| 15 | **Promote Button + consolidate Modal (Escape/focus/aria)** | H2, H4, H5 | M-L |
| 16 | **Document soft-delete lifecycle + fix mkdocs nav orphans** | D4, D5 | M |
| 17 | **Stop `catch{}`-as-feature-detection: startup capability map** | Q2 (+ removes a bug class) | M |
| 18 | **De-dup API helpers + delete legacy GraphUsers fallbacks + drop runtime DDL** | Q4, Q5, Q6, Q7 | M |
| 19 | **JS coverage thresholds + Pester floor + add python to CodeQL** | F5, F9 | M |
| 20 | **Single interactive accent (blue) sweep** | H1 | M |

### Tier 3 — Larger / structural (schedule deliberately)
| # | PR slice | Fixes | Effort |
|---|----------|-------|--------|
| 21 | **Split matrix.js god-module into handlers/** + generalize runBound | Q1, Q3 | L |
| 22 | **Matrix column virtualization** | P4 | L |
| 23 | **OpenAPI read-API: generate or scope-and-cross-link** | D1, D11 | L |
| 24 | **Rewrite data-model.md Contexts section (ContextMembers model)** | D9 | L |
| 25 | **Flat-matrix pagination (cursor/keyset)** | P2 | L |
| 26 | **Mocked Pester units for crawlers + auth-enabled CI flow** | F8, F-auth gap | L |
| 27 | **Azure "Isolated" template (private endpoints) + random DB password + verify-full TLS** | L-4, L-5, L-7 | L |
| 28 | **Semantic design-token layer in index.css** | L3 (root cause of C1/H1) | M-L |

### Defense-in-depth / lower priority (batch as capacity allows)
M-3, M-5, M-6, L-1, L-2, L-3, L-6, I-1 (security hardening) · M2 toast system · M3 icon set · M5/M7/M8 visual polish · F10-F13 CI hygiene · D10 README.

---

## Notable strengths (no action — keep doing this)
- Fail-closed permission resolution, no wildcard fallback; correct JWT pinning; read-token GET-only/non-admin scoping.
- Uniform SQL parameterization with `SAFE_IDENT_RE` + information_schema identifiers — no injection found across ~40 interpolation sites.
- AES-256-GCM envelope encryption, no hardcoded key, no secret logging; re2 for all regexes; real scraper SSRF defense.
- Perf middleware correctly off-by-default (P9). TODO/FIXME density near-zero in app/src (Q8).
- CI: SHA-pinned actions, scope-aware filters with safe fallback, aggregator gates.

---

# Codex Cross-Check Reconciliation (outside voice)

Added after the initial Claude-only audit. Five independent `codex exec` runs
(codex-cli 0.142.2), one per dimension, each told to challenge the Claude findings
and hunt for what was missed. Their highest-impact disputes/net-new claims were then
re-verified by hand against source. Net result: **Codex confirmed nearly every
Claude Critical/High finding**, corrected a few severities, and — crucially — **broke
the security pass's headline conclusion** with five real authorization gaps.

## Agreement
Codex returned CONFIRMED on: C1, C2, C3, H1-H6, M2, M8 (design) · H-1, M-1..M-6, L-1,
L-5, I-1 (security) · P1-P5, P7, Q1, Q2, Q6, Q7 (perf/quality) · F1-F7, F9, F10, F12,
AUTH-GAP (CI) · D1-D6, D9, D12 (docs). No Claude Critical/High was refuted.

## Severity / accuracy corrections (adopt Codex)
- **C1, C2** dark-mode duplication: Critical → **Medium-High**. It's pervasive and real,
  but contrast degradation in dark mode is not "Critical." Keep it as Tier-1 (the fix is
  trivial) but label severity honestly.
- **H1**: RollupMatrixView uses **indigo**, not teal. Same finding, corrected color. The
  accent-sprawl point stands (blue/lime/indigo all present).
- **H4**: the MatrixView modal line citation is imprecise — the *finding* (no Escape/focus-
  trap/role across overlays) holds; fix the line reference when implementing.
- **D7**: Codex returned NEEDS-CONTEXT only because CLAUDE.md was outside its sandbox —
  not a real dispute. The v3.1/v3.2 label drift stands.

## NEW security findings (Codex net-new — verified by hand, NOT in the original audit)
These are the most important output of the cross-check. All assume `AUTH_ENABLED=true`.

| ID | Sev | Location | Issue (verified) | Fix | Effort |
|----|-----|----------|------------------|-----|--------|
| SEC-NEW-1 | ~~High~~ **WITHDRAWN — by design** | `app.js:294-309` + read routers | **Original claim (Codex + Claude):** the read routers (matrix/details/resources/governance/…) apply no `requirePermission`, so any authenticated tenant user can read all data. **Correction (verified against `auth/permissionManifest.js`):** this is *intended, documented, tested* design. `data.read` is classified as an **IMPLICIT** permission — *"Authentication-required: any signed-in user can read… No requirePermission gate"* — and is covered by `auth/permissionMatrix.test.js`. "Any signed-in user can read" is the deliberate model; the C-01 fix scoped fail-closed behavior to *admin/write* endpoints specifically. Restricting reads to particular roles is a config choice via `AUTH_REQUIRED_ROLES`, not a defect. **Lesson:** both the outside voice *and* the hand-verification confirmed "no gate exists" but missed *why* — a reminder that "missing check" ≠ "vulnerability" without the threat model. | No code change. Optionally document `AUTH_REQUIRED_ROLES` more prominently as the knob to lock down read access. | — |
| SEC-NEW-2 | **High** | `routes/crawlers.js:386-419` | `POST /api/crawlers/jobs/claim` checks only `req.crawler` (any valid `fgc_` key), claims the next queued job regardless of which crawler/system owns it, and `injectJobSecret(job)` (line 414) injects the vaulted clientSecret into the response. **Any valid crawler key can drain the job queue and exfiltrate another system's Graph credentials.** The `crawlerHasSystemAccess`/`crawlerHasPermission` helpers (crawlerAuth.js:154-163) exist but are unused here. Mitigating: in a default install the built-in worker holds the only key — exposure scales with how many external crawler keys exist. | Scope job-claim to the calling crawler's `systemIds`/identity; gate secret injection on ownership. | M |
| SEC-NEW-3 | Med | `routes/crawlers.js:427,457,484(+DELETE)` | `mark-delta-mode` and the `delta-tokens` GET/PUT/DELETE take a config id / `systemId` from the request and check only `req.crawler` — never `crawlerHasSystemAccess(req, systemId)`. A crawler scoped to system A can read/overwrite system B's delta tokens or flip any config to delta mode (→ skipped full sync, stale data). | Call the existing `crawlerHasSystemAccess` helper on every systemId-bearing crawler endpoint. | S |
| SEC-NEW-4 | Low | `routes/perf.js:60,68` | `POST /api/perf/clear` and `POST /api/perf/toggle` have no `requirePermission` (perfRouter mounted authMiddleware-only at app.js:294). Any authenticated user can wipe collected metrics or disable the perf collector. | Gate behind an admin/perf permission. | S |
| SEC-NEW-5 | ~~Low-Med~~ **WITHDRAWN — by design** | `routes/matrix.js` saved-filters | **Original claim:** saved-filter create/update/delete (incl. the org-wide default) run for any authenticated user with no write permission. **Correction (verified):** this is intended design — migration `023_saved_matrix_filters.sql` documents it explicitly: *"Org-wide visibility: every signed-in analyst can list, load, rename, and delete every saved filter."* Saved filters are a shared, collaborative view preset, consistent with the read surface being open to any signed-in user (see SEC-NEW-1). Mitigations already in place: `fgr_` read tokens cannot call these endpoints (auth middleware blocks non-GET for read tokens), and every change is attributed (`createdBy`/`updatedBy`). | No code change. If a deployment wants least-privilege on the *org-wide default view*, gate only the `isDefault` toggle behind an admin permission — left as an optional config decision. | — |

**Revised security conclusion:** no *unauthenticated* exploit; SQL parameterization,
secrets, and crypto all hold. The real authenticated-authorization gaps were on the
**crawler protocol** (SEC-NEW-2 secret exfil via job-claim, SEC-NEW-3 cross-system
delta tokens) and the ungated **perf mutation** endpoints (SEC-NEW-4) — all fixed.
Two findings turned out to be **intended design**, not vulnerabilities: the read
surface open to any signed-in user (SEC-NEW-1) and the shared saved-filter mutations
(SEC-NEW-5). The remaining real priority is the Bicep secret leak **H-1**.

**Remediation status (added post-review):** SEC-NEW-2, SEC-NEW-3, and SEC-NEW-4 are
fixed in **PR #424** (`bugfixes/security-authz-enforcement`). SEC-NEW-1 and SEC-NEW-5
are withdrawn as intended design. **H-1 (Bicep) has since been remediated in #475** (keys removed from the Bicep outputs); the remaining open security items are the Low-tier infrastructure hardening (L-1…L-8) plus the upload bounds (M-4) — see the [Remediation Status](#remediation-status) table above.

## Net-new (non-security) Codex catches — worth confirming + folding in
- **Perf (Codex, spot-plausible, not yet hand-verified):** `riskScores.js:131/140/159`
  "top 10" users/resources queries + latest-scored-at lack `LIMIT` (return all rows);
  `details.js:442` group-members + `resources.js:330` assignments unpaginated;
  `MatrixView.jsx:395` client-side O(groups×users) nested count loop;
  `SortableMatrixBody.jsx:68` dragging disables virtualization (mounts all rows).
- **CI (Codex):** path filters ignore config-file changes — `pr.yml:123` API scope ignores
  package/eslint config, `:125` UI scope ignores `app/ui/e2e` + playwright config,
  `pr-integration.yml:122` e2e filter ignores e2e/playwright config, `:111` integration
  filter ignores `test/nightly`+demo data → **a PR touching only those can skip the very
  tests meant to cover it.** Also `skip-hygiene` (pr.yml:423) and `skip-load-soak`
  (:784) labels bypass required gates; `users-page.spec.js:8` uses fixed sleeps not
  readiness asserts (flake source).
- **Docs (Codex):** `docs/api/entities.md` references nonexistent `mat_UserPermissionAssignments`
  (code uses `vw_UserPermissionAssignments`) and `/api/perf/slowest` (route is `/api/perf/slow`);
  `risk-scoring-model.md` still uses SQL-Server types (`NVARCHAR`/`DATETIME2`/`BIT`);
  more public endpoints undocumented (`/api/version`, `/api/features`, `/api/openapi.json`).
- **Design (Codex a11y net-new):** App.jsx:491 toggle has no accessible name/state;
  App.jsx:556 detail-tab close is a keyboard-inaccessible span; DashboardPage FeatureCard,
  AccessPackagesPage category filter, FilterBar select, UsersPage swatches/select-all,
  AccessPackagesPage sortable `th` — all repeat the clickable-non-control a11y pattern (H3).

## Backlog changes from the cross-check
**Promote into Tier 1 (high value, low-ish effort):**
- **SEC-NEW-2** (crawler job-claim secret exposure) — scope to caller. **M.**
- **SEC-NEW-3** (use the existing `crawlerHasSystemAccess` helper) — **S.**
- **SEC-NEW-4** (gate perf clear/toggle) — **S.**
- **CI path-filter gaps** (PR touching only config/e2e can skip its own tests) — **S.**

**Promote into Tier 2:**
- ~~SEC-NEW-1~~ — **withdrawn**, intended design (see correction above). No fix.
- ~~SEC-NEW-5~~ — **withdrawn**, intended design (migration 023 documents shared org-wide saved filters). No fix.
- **riskScores top-N missing LIMIT** + unpaginated detail/assignment endpoints — **S-M**
  (confirm first).

