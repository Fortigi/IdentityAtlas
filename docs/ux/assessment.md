# UX & Interface Assessment & Remediation

Identity Atlas underwent an independent **UX / GUI audit** in June 2026, conducted pentest-style: a read-only, evidence-cited review of the entire React UI (~70 components) across **twelve specialist passes** — six by *lens* and six by *region* — walking every screen, wizard step, and sub-page.

This page is a **public, sanitized summary**: it records what was assessed, the findings by severity and status, and the pull requests that remediated them. Internal file/line evidence and the full twelve-pass transcripts are deliberately omitted. The full audit is kept with the project maintainers.

!!! info "Why we publish this"
    We hold our own interface to the same standard as our security posture. The audit was deliberately self-critical; every Critical and High finding is tracked openly below, and the foundational fixes (an enforced Style Guide, a design-system lint gate, an accessibility baseline) have been merged to `main`. Remaining items are listed honestly as in progress or planned.

---

## Scope

- **The entire React UI** (`app/ui/src`, ~70 components): the dashboard, the matrix (the core analytical surface), all entity-detail variants, the crawler-configuration wizards, the Admin sub-pages, risk scoring, account correlation, contexts, and the application shell.
- **Six lenses:** information architecture & navigation, colour & brand, component consistency, user-flow consistency, help & terminology, and accessibility.
- **Six regions:** crawler config, Admin, entity-detail pages, the matrix end-to-end, risk/correlation/contexts, and the dashboard + list pages + shell.

**Method:** manual, read-only review with every finding cited to `file:line`, deduped and rated by severity. No files were modified during the audit itself.

---

## Result at a glance

| Severity | Found | Remediated / in progress | Open |
|---|---|---|---|
| Critical | 4 | 3 | 1 |
| High | 21 | 15 | 6 |
| Medium | ~35 | several | most |
| Low / Informational | ~30 | several | most |

The audit's headline: a **strong foundation with a missing middle** — a healthy design-*token* layer and one genuinely excellent flow (the matrix filter wizard), but no shared *component* layer, no terminology/help system, and uneven dark-mode and accessibility coverage, so the same control had drifted across colours and patterns. The remediation programme therefore prioritised **foundations** (a written Style Guide, CI enforcement, an accessibility baseline) alongside the highest-impact individual fixes.

---

## Findings & remediation

> **Maintenance note — do not edit this table on a feature/bugfix branch.** Flipping a finding's status (or recomputing any roll-up) on a branch reliably conflicts here, because every branch touches the same rows while `main` moves on. Leave these tables to a single **reconciliation pass on `main`** after PRs merge. A feature PR changes only code, tests, and its `changes/` fragment; the status below is flipped later, in one batch.

Status legend: ✅ **Fixed** (merged) · 🟨 **Partially addressed** · 🔧 **Remediation planned**.

### Critical

| ID | Finding | Status | PR / tracking |
|---|---|---|---|
| C-01 | The matrix had no on-screen legend — its core surface (coloured single letters) was undecipherable without external docs | ✅ Fixed | [#226](https://github.com/Fortigi/IdentityAtlas/pull/226), [#250](https://github.com/Fortigi/IdentityAtlas/pull/250) |
| C-02 | Identity Correlation is a dead-end flow: a ruleset can be saved but not run from the UI, and the review loop is half-built | ✅ Resolved by rebuild — the LLM correlation flow was removed and replaced by deterministic [Account Linking](../architecture/account-linking.md): an editable dictionary + certainty slider under Admin → Account Linking, runs triggered on a schedule or on demand from the UI, and a per-account confirm/reject review loop on the identity detail page | — |
| C-03 | The matrix "governed" concept had multiple definitions that could contradict across the panel and the two grids | 🟨 Partially addressed — panel + main grid unified on business-role coverage; rotated view pending | [#776](https://github.com/Fortigi/IdentityAtlas/issues/776) |
| C-04 | Accessibility: the app was substantially keyboard- and screen-reader-inoperable (focus, reduced-motion, real controls, labels) | 🟨 Partially addressed — global focus-visible, skip link & reduced-motion baseline merged, and the axe-core suite re-armed across all nav tabs; modal focus-trap and a full real-controls sweep remain | [#229](https://github.com/Fortigi/IdentityAtlas/pull/229), [#236](https://github.com/Fortigi/IdentityAtlas/pull/236), [#525](https://github.com/Fortigi/IdentityAtlas/pull/525) · [#751](https://github.com/Fortigi/IdentityAtlas/issues/751) |

### High

| ID | Finding | Status | PR / tracking |
|---|---|---|---|
| H-01 | No shared component layer — primitives quarantined; the same action rendered in several colours/styles | 🟨 Partially addressed — shared `Stepper`, unified interactive colour to blue, softened data-viz | [#241](https://github.com/Fortigi/IdentityAtlas/pull/241), [#242](https://github.com/Fortigi/IdentityAtlas/pull/242) · [#750](https://github.com/Fortigi/IdentityAtlas/issues/750) |
| H-02 | Detail pages are "two products in one" (shared-layout vs bespoke; a stale duplicate Group page) | 🔧 Planned | [#764](https://github.com/Fortigi/IdentityAtlas/issues/764) |
| H-03 | Entire Contexts tab broken in dark mode | ✅ Fixed | [#227](https://github.com/Fortigi/IdentityAtlas/pull/227) |
| H-04 | Several regions light-mode only (crawler job-detail modal, compliance & account-type badges) | ✅ Fixed | badges [#232](https://github.com/Fortigi/IdentityAtlas/pull/232) · job-detail modal [#817](https://github.com/Fortigi/IdentityAtlas/pull/817) · [#765](https://github.com/Fortigi/IdentityAtlas/issues/765) |
| H-05 | Botched automated dark-mode pass left doubled/contradictory classes | 🟨 Partially addressed | [#233](https://github.com/Fortigi/IdentityAtlas/pull/233) |
| H-06 | Roles & Permissions is buried inside Authentication; the described self-lockout guard isn't implemented | 🔧 Planned | [#786](https://github.com/Fortigi/IdentityAtlas/issues/786) |
| H-07 | Risk Scoring can't be created/run from its own page; dead cluster code | 🔧 Planned | [#766](https://github.com/Fortigi/IdentityAtlas/issues/766) |
| H-08 | Admin → Data tab gating mismatch (sections render regardless of the entry permission) | ✅ Fixed — each Data section now renders only for the permission that backs its server route | [#807](https://github.com/Fortigi/IdentityAtlas/pull/807) · [#767](https://github.com/Fortigi/IdentityAtlas/issues/767) |
| H-09 | Matrix "Apply vs Save" is a trap (overlapping verbs; a scolding "Not saved" badge) | 🔧 Planned | [#768](https://github.com/Fortigi/IdentityAtlas/issues/768) |
| H-10 | Rotated matrix is a silent reduced mode while still showing the controls it drops | 🔧 Planned | [#769](https://github.com/Fortigi/IdentityAtlas/issues/769) |
| H-11 | Core concepts never defined on screen (matrix, subjects, governed, gaps) | 🟨 Partially addressed — matrix legend + Style Guide glossary | [#226](https://github.com/Fortigi/IdentityAtlas/pull/226), [#237](https://github.com/Fortigi/IdentityAtlas/pull/237) · [#772](https://github.com/Fortigi/IdentityAtlas/issues/772) |
| H-12 | List pages dead-end new users; Systems cited a stale CLI command | 🟨 Partially addressed — Systems onboarding fixed; remaining list pages pending | [#230](https://github.com/Fortigi/IdentityAtlas/pull/230) · [#760](https://github.com/Fortigi/IdentityAtlas/issues/760) |
| H-13 | Optional tabs (Risk Scores, Identities) hidden by default even when enabled | ✅ Fixed — a feature-gated tab surfaces whenever its feature is on, with no second per-user opt-in | [#827](https://github.com/Fortigi/IdentityAtlas/pull/827) · [#770](https://github.com/Fortigi/IdentityAtlas/issues/770) |
| H-14 | List-page sort silently sorts only the current page over server pagination | ✅ Fixed — sort pushed to the server over the full result set (validated column allowlist) | [#823](https://github.com/Fortigi/IdentityAtlas/pull/823) · [#771](https://github.com/Fortigi/IdentityAtlas/issues/771) |
| H-15 | Dashboard backend error masqueraded as an "empty database" onboarding state | ✅ Fixed | [#235](https://github.com/Fortigi/IdentityAtlas/pull/235) |
| H-16 | Almost no contextual help / doc links; no in-app glossary | 🔧 Planned | [#772](https://github.com/Fortigi/IdentityAtlas/issues/772) |
| H-17 | Terminology drift leaked internal jargon (SOLL/IST, "Org Unit", "Access Package") into the UI | ✅ Fixed — strings corrected + a CI rule blocks regressions | [#228](https://github.com/Fortigi/IdentityAtlas/pull/228), [#243](https://github.com/Fortigi/IdentityAtlas/pull/243), [#238](https://github.com/Fortigi/IdentityAtlas/pull/238) |
| H-18 | CSV import validates only the filename, not headers; loose name-matching can mis-map | ✅ Fixed — uploaded files are header-validated against the mapped schema at staging time | [#824](https://github.com/Fortigi/IdentityAtlas/pull/824) · [#773](https://github.com/Fortigi/IdentityAtlas/issues/773) |
| H-19 | One-time API key trivially lost; Copy reports success even when the clipboard fails | ✅ Fixed — verified copy reports the real result, plus a copy button for the reset key | [#826](https://github.com/Fortigi/IdentityAtlas/pull/826) · [#774](https://github.com/Fortigi/IdentityAtlas/issues/774) |
| H-20 | Crawler "audit log" fetches data but renders nothing | ✅ Fixed — the Custom Connector card's audit-log panel now fetches and renders its entries (rebuilt in the connector externalization, 2 weeks after this audit); guarded by an e2e | [#364](https://github.com/Fortigi/IdentityAtlas/pull/364) · [#775](https://github.com/Fortigi/IdentityAtlas/issues/775) |
| H-21 | ~11 native `confirm()`/`alert()`/`prompt()` for important actions — unstyled, no dark mode, untestable | 🟨 Partially addressed — a shared `DialogProvider` landed and a CI rule blocks new ones; ~7 components (AccessPackages, matrix/risk wizards, Roles & Permissions, LLM/Power-Query settings) are still being migrated | [#238](https://github.com/Fortigi/IdentityAtlas/pull/238), [#500](https://github.com/Fortigi/IdentityAtlas/pull/500) · [#763](https://github.com/Fortigi/IdentityAtlas/issues/763) |

### Medium & Low

Around 35 Medium and 30 Low/Informational items were recorded — inconsistent sub-navigation, no breadcrumbs, ad-hoc empty/loading states, tag-pill contrast risks, the orphaned brand colour and button-colour drift, ad-hoc type sizes, and assorted polish. Several have already been resolved as part of the foundational work below (terminology, the brand/colour decision, the matrix Tags column, a null-guard crash); the remainder are tracked in [#777](https://github.com/Fortigi/IdentityAtlas/issues/777) and scheduled alongside the High items. Technical detail is withheld here pending remediation.

---

## Supporting work

Beyond the per-finding fixes, the remediation programme added the **foundations the audit said were missing**:

- **A written, enforced UI Style Guide** — codifies the two-role colour system (green = brand, blue = interactive), dark-mode and accessibility rules, the data-viz saturation rule, component conventions, and a terminology glossary ([#237](https://github.com/Fortigi/IdentityAtlas/pull/237), [#245](https://github.com/Fortigi/IdentityAtlas/pull/245)).
- **A CI "design-system lint" gate** — blocks native dialogs and legacy jargon in new code, on top of the existing contrast rule ([#238](https://github.com/Fortigi/IdentityAtlas/pull/238)).
- **A visual-consistency sweep** — a shared stepper, one interactive colour, softened data-visualisation fills, and the removal of the stale matrix Tags column ([#241](https://github.com/Fortigi/IdentityAtlas/pull/241), [#242](https://github.com/Fortigi/IdentityAtlas/pull/242), [#243](https://github.com/Fortigi/IdentityAtlas/pull/243)).
- **Documentation that matches the product** — the docs site now mirrors the app's shell and brand ([#239](https://github.com/Fortigi/IdentityAtlas/pull/239), [#244](https://github.com/Fortigi/IdentityAtlas/pull/244)).

---

## Strengths (confirmed)

The audit confirmed real strengths, preserved throughout remediation:

- **A genuine design-token layer** — centralised colour palettes and tier/badge style maps.
- **One excellent flow** — the matrix filter wizard with live preview counts.
- **A WCAG contrast lint rule** already in place, now joined by the broader design-system gate.
- **Dark-mode intent** throughout, now being completed region by region.

---

## Remediation roadmap

| Priority | Theme | Status |
|---|---|---|
| **P0** | Legibility & trust — matrix legend & "how to read", dashboard error ≠ empty | ✅ Complete |
| **P1** | Design-system foundation — Style Guide, CI lint, accessibility baseline, interactive-colour unification | 🟨 In progress |
| **P2** | Dark mode & brand — complete dark mode region by region; finish the colour decision | 🟨 In progress |
| **P3** | IA & onboarding — unify the detail-page family, promote Roles & Permissions, guiding empty states, surface optional tabs | 🔧 Scheduled |
| **P4** | Help & governance — per-page doc links + glossary, finish/fence half-built features | 🔧 Scheduled |

A follow-up re-audit is recommended once the P2–P3 items are remediated.

---

*This page is a sanitized public summary. The full audit, with per-finding file/line evidence across the twelve specialist passes, is kept with the project maintainers. No files or deployments were modified during the audit itself — it was a read-only inspection.*
