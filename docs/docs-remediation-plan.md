# Documentation Remediation Plan (living document)

> **Purpose:** Werkdocument om **feature voor feature** te beoordelen of elke verscheepte feature terugkomt in de documentatie, met onderscheid **per type documentatie**. Voortbouwend op de bevindingen in [`docs-gap-audit.md`](docs-gap-audit.md).
> **Basis:** edge (`main` @ `d4afdb9f`, v5.441). **Branch:** `feature/docs-gap-audit` (lokaal).
> **Status:** review nog niet gestart — grids zijn de vooraf-ingevulde startsituatie uit de audit.

## Methode

Elke feature wordt beoordeeld langs drie documentatie-assen. **Gebruikersdoc is primair.**

| As | Voor wie | Thuisbasis | Prioriteit |
|----|----------|-----------|-----------|
| **Gebruiker** | Eindgebruiker: hoe gebruik ik dit scherm/feature | `docs/ui/`, `docs/quickstart.md`, gebruikersdeel `docs/sync/` & `docs/admin/` | **P1** |
| **Operator** | Installeren, configureren, draaien | `docs/admin/`, `docs/reference/config.md`, deployment/docker, security, operations | P2 |
| **Contributor/API** | Meebouwen/integreren | `docs/architecture/`, `docs/api/`, `building-a-crawler.md`, `CLAUDE.md`-files, `docs/reference/sql-views.md` | P2/P3 |

**Statuslegenda:** ✅ gedekt · 🟡 partieel/stale · ⭕ ontbreekt · — n.v.t.
`docs/concepts/` telt bij zowel Gebruiker als Contributor; `docs/marketing/` is buiten scope.

## Werkwijze per cluster

1. We bekijken het **dekkings-grid** van het cluster.
2. Per gap besluit jij: gebruikersdoc nodig? operator-/contributor-doc? prioriteit? of "accepteer".
3. Besluiten komen in de **backlog-tabel** van dat cluster; status van het cluster wordt bijgewerkt.
4. Door naar het volgende cluster.

**Backlog-kolommen:** `feature | doc-type | actie (schrijf/werk-bij/fix/accepteer) | prioriteit | doeldoc-bestand | notitie`.

## Voortgang

| # | Cluster | Status |
|---|---------|--------|
| 1 | Aan de slag & Dashboard | ⬜ te doen |
| 2 | Matrix | ⬜ te doen |
| 3 | Contexts | ⬜ te doen |
| 4 | Entities & detailpagina's | ⬜ te doen |
| 5 | Risk scoring & AI/LLM | ⬜ te doen |
| 6 | Governance / business roles | ⬜ te doen |
| 7 | Sync-bronnen / crawlers | ⬜ te doen |
| 8 | Admin & instellingen | ⬜ te doen |
| 9 | Integratie & ingest-API | ⬜ te doen |
| 10 | Platform & datamodel | ⬜ te doen |

---

## Cluster 1 — Aan de slag & Dashboard

**Dekkings-grid (startsituatie):**

| Feature | Gebruiker | Operator | Contributor/API |
|---------|:---------:|:--------:|:---------------:|
| Quickstart / eerste crawler toevoegen | 🟡 | 🟡 | — |
| Dashboard-landingspagina (cards, brain-graph, counts, risk-status, CTA's) | ⭕ | — | 🟡 |
| Trends-tab (dagelijkse snapshots/time-series) | ⭕ | — | ✅ |

**Backlog:**

| Feature | Doc-type | Actie | Prio | Doeldoc | Notitie |
|---------|----------|-------|------|---------|---------|
| _(in te vullen tijdens review)_ | | | | | |

---

## Cluster 2 — Matrix

**Dekkings-grid (startsituatie):**

| Feature | Gebruiker | Operator | Contributor/API |
|---------|:---------:|:--------:|:---------------:|
| Basis-view (badges, staircase-sort, DnD-reorder, IST-SOLL, Excel-export) | 🟡 | — | ✅ |
| Filter-Wizard (3-staps + opgeslagen matrices) | ⭕ | — | ⭕ |
| Roll-up-by-attribute (count/percent, content-modi) | ⭕ | — | ⭕ |
| Oriëntatie / geroteerde view | ⭕ | — | ⭕ |
| Scope-statistieken (in-scope counts, governed %, trends) | 🟡 | — | ✅ |
| Matrix-interactie-endpoints (preview, hierarchy-paths, saved-filters CRUD) | — | — | ⭕ |

**Backlog:**

| Feature | Doc-type | Actie | Prio | Doeldoc | Notitie |
|---------|----------|-------|------|---------|---------|
| _(in te vullen tijdens review)_ | | | | | |

---

## Cluster 3 — Contexts

**Dekkings-grid (startsituatie):**

| Feature | Gebruiker | Operator | Contributor/API |
|---------|:---------:|:--------:|:---------------:|
| Context-model (synced/generated/manual × 4 targettypes) | ⭕ | — | 🟡 (status "not yet implemented") |
| Contexts-scherm (tree, drag-reparent, New-Context-wizard, Filter-matrix) | ⭕ | — | 🟡 (spec mislabeled) |
| Plugin-catalogus (10 plugins; 5 ongedocumenteerd/mis-benoemd) | ⭕ | ⭕ | 🟡 |
| `risky-consent` externe threat-feed-egress | — | ⭕ | ⭕ |
| Tags als context (`contextType='Tag'`) | 🟡 (stale GraphTags-ref) | — | 🟡 |
| Admin → Plugins-subtab | ⭕ | ⭕ | 🟡 |
| Context write- + plugin-API (`/contexts` writes, `/context-plugins/*`) | — | — | ⭕ |

**Backlog:**

| Feature | Doc-type | Actie | Prio | Doeldoc | Notitie |
|---------|----------|-------|------|---------|---------|
| _(in te vullen tijdens review)_ | | | | | |

---

## Cluster 4 — Entities & detailpagina's

**Dekkings-grid (startsituatie):**

| Feature | Gebruiker | Operator | Contributor/API |
|---------|:---------:|:--------:|:---------------:|
| Lijst+detail: Principals / Identities / Resources / Systems | 🟡 (stale namen/OrgUnits-ref) | — | ✅ |
| Entity-detail-tabs (attributen / graph / timeline / risk) | 🟡 (arch-only) | — | ✅ |
| Account-linking (linked accounts, confidence, confirm/reject) | ✅ | — | ✅ |
| Secundaire detail-endpoints (contexts/assignments/business-roles/oauth2-grants) | — | — | ⭕ |

**Backlog:**

| Feature | Doc-type | Actie | Prio | Doeldoc | Notitie |
|---------|----------|-------|------|---------|---------|
| _(in te vullen tijdens review)_ | | | | | |

---

## Cluster 5 — Risk scoring & AI/LLM

**Dekkings-grid (startsituatie):**

| Feature | Gebruiker | Operator | Contributor/API |
|---------|:---------:|:--------:|:---------------:|
| 4-laags engine + risk-tiers | 🟡 (tier-cutoffs FOUT) | — | 🟡 (tier-cutoffs FOUT) |
| Classifiers (generatie-flow) | 🟡 | — | 🟡 (beschrijft gestubd PS-pad) |
| Analyst-overrides | ✅ | — | ✅ |
| AI-agent-scoring | 🟡 | — | 🟡 (stale functie-refs) |
| LLM-classifier-generatie (Node-service vs. PS-stub) | — | 🟡 | 🟡 |
| Risk-profile/classifier-API (~20 endpoints) | — | — | 🟡 (alleen narratief) |
| Admin → Risk-Scoring-wizard & LLM-settings-scherm | ⭕ | 🟡 | 🟡 |

**Backlog:**

| Feature | Doc-type | Actie | Prio | Doeldoc | Notitie |
|---------|----------|-------|------|---------|---------|
| _(in te vullen tijdens review)_ | | | | | |

---

## Cluster 6 — Governance / business roles

**Dekkings-grid (startsituatie):**

| Feature | Gebruiker | Operator | Contributor/API |
|---------|:---------:|:--------:|:---------------:|
| Business roles / governed assignments / resource grants | ✅ | — | ✅ |
| Certificeringen (CertificationDecisions) | 🟡 | — | ✅ |
| Assignment-policies / -requests | — | — | ✅ |
| IGA-platform-mapping (Entra/Omada/SailPoint) | — | — | ✅ |
| Governance-summary / review-compliance-API | — | 🟡 | 🟡 (niet in api/governance.md) |

**Backlog:**

| Feature | Doc-type | Actie | Prio | Doeldoc | Notitie |
|---------|----------|-------|------|---------|---------|
| _(in te vullen tijdens review)_ | | | | | |

---

## Cluster 7 — Sync-bronnen / crawlers

**Dekkings-grid (startsituatie):**

| Feature | Gebruiker | Operator | Contributor/API |
|---------|:---------:|:--------:|:---------------:|
| Entra ID (6 phase-toggles + AI-agent-classificatie) | 🟡 (flags-tabel/diagram stale) | 🟡 | 🟡 |
| Azure RM (`onlyEntraPrincipals`-optie) | 🟡 | 🟡 | ✅ |
| midPoint | ✅ | ✅ | 🟡 (streaming/dept-derivatie dev-only) |
| Omada | ✅ | ✅ | ✅ |
| CSV-import (nieuwe templates: Contexts/ContextMembers/Certifications/ResourceRelationships) | 🟡 | 🟡 | 🟡 |
| Custom Connector (push-mode) | ⭕ | ⭕ | ✅ (ingest-api.md) |
| Wizard/plugin-architectuur + live discovery | — | — | ✅ |

**Backlog:**

| Feature | Doc-type | Actie | Prio | Doeldoc | Notitie |
|---------|----------|-------|------|---------|---------|
| _(in te vullen tijdens review)_ | | | | | |

---

## Cluster 8 — Admin & instellingen

**Dekkings-grid (startsituatie):**

| Feature | Gebruiker | Operator | Contributor/API |
|---------|:---------:|:--------:|:---------------:|
| Authentication / Roles & Permissions-editor | ⭕ | 🟡 (permissions.md lijst) | 🟡 |
| Updates (auto-update, kanaal, historie) | ✅ | ✅ | ✅ |
| Data-tab (PowerQuery-export ✅; curated import/export, retention, danger zone ⭕) | 🟡 | 🟡 | 🟡 |
| Performance | ✅ | 🟡 | 🟡 (perf-endpoint drift: `/perf/slowest`→`/perf/slow`) |
| Crawler config audit/reset | — | ⭕ | ⭕ |
| About / SBOM / licentie | 🟡 | ✅ | ✅ |

**Backlog:**

| Feature | Doc-type | Actie | Prio | Doeldoc | Notitie |
|---------|----------|-------|------|---------|---------|
| _(in te vullen tijdens review)_ | | | | | |

---

## Cluster 9 — Integratie & ingest-API

**Dekkings-grid (startsituatie):**

| Feature | Gebruiker | Operator | Contributor/API |
|---------|:---------:|:--------:|:---------------:|
| Ingest-API (`/ingest/*`, openapi.yaml) | — | ✅ | ✅ |
| Custom-connector push-mode (opzet + kaart) | ⭕ | ⭕ | ✅ |
| API-key-beheer / rotatie / audit | ⭕ | 🟡 | ✅ |
| Drift-guard-scope (welke routes bewaakt zijn) | — | — | 🟡 (alleen in test) |

**Backlog:**

| Feature | Doc-type | Actie | Prio | Doeldoc | Notitie |
|---------|----------|-------|------|---------|---------|
| _(in te vullen tijdens review)_ | | | | | |

---

## Cluster 10 — Platform & datamodel

**Dekkings-grid (startsituatie):**

| Feature | Gebruiker | Operator | Contributor/API |
|---------|:---------:|:--------:|:---------------:|
| Datamodel (v3.1 + v6 contexts) | — | — | 🟡 (stale table-refs / collapsed types "in use") |
| Effective-access-engine (P1 direct + P2 inherited) | — | — | ✅ |
| Soft-delete | — | 🟡 | ✅ |
| Audit-history / timeline | 🟡 | — | ✅ |
| Assignment-model-collapse (migraties 044/045) | — | — | 🟡 (status "no code yet") |
| Deployment / Docker / Azure | — | ✅ | ✅ |
| Scaling | — | 🟡 | ✅ |

**Backlog:**

| Feature | Doc-type | Actie | Prio | Doeldoc | Notitie |
|---------|----------|-------|------|---------|---------|
| _(in te vullen tijdens review)_ | | | | | |
