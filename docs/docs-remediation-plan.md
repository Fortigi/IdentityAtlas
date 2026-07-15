# Documentation Remediation Plan v2 (living document)

> **Purpose:** Vaststellen of de IdentityAtlas-documentatie (a) **compleet** is t.o.v. verscheepte features én (b) **bruikbaar** is voor de gestelde doelen — en de gaten gestructureerd wegwerken. Voortbouwend op [`docs-gap-audit.md`](docs-gap-audit.md).
> **Basis:** edge (`main` @ `d4afdb9f`, v5.441). **Branch:** `feature/docs-gap-audit` (lokaal).
> **v2-wijziging (na dual-voice review):** bruikbaarheid wordt gemeten met **journey-walkthroughs (primair instrument)**; het coverage-grid is **ondersteunend inventaris**. Zie de [Review-appendix](#review-appendix-dual-voice) onderaan.

## Waarom v2

De v1 mat uitsluitend *aanwezigheid* per feature (✅/🟡/⭕). Een onafhankelijke review met vier voices (drie Claude-subagents + Codex, alle op de echte bestanden) concludeerde unaniem: dat beantwoordt goal (a) maar **niet goal (b)**. Een cluster kan volledig groen worden en tóch docs opleveren waar een echte gebruiker op vastloopt (aanwezig ≠ correct ≠ vindbaar ≠ uitvoerbaar). v2 repareert dit met twee instrumenten en een aantal proces-gates.

---

## De twee instrumenten

### Instrument A — Coverage-grid (ondersteunend: *compleetheid*)
Per feature × doc-type-as een statuscel. Beantwoordt: *bestaat er correcte documentatie voor deze feature?* Dit is inventaris/traceerbaarheid, geen bewijs van bruikbaarheid.

### Instrument B — Journey-walkthroughs (**primair**: *bruikbaarheid*)
Een kleine set benoemde persona-taken die end-to-end met **alléén de docs** wordt doorlopen door iemand die de betreffende doc **niet** schreef. Dit is de acceptatietest voor "bruikbaar voor de gestelde doelen". Een cluster/journey is pas klaar als de walkthrough slaagt.

---

## Doc-type-assen (4, na review)

**Analyst/Gebruiker is primair (P1).** Voor dit product (role-mining / access-governance) is de kern-eindgebruiker de **Analyst/Reviewer** die onderzoekt en attesteert — niet een generieke "hoe gebruik ik dit scherm"-lezer.

| As | Voor wie | Thuisbasis | Prio |
|----|----------|-----------|------|
| **Analyst/Gebruiker** | Role-mining/attestatie-eindgebruiker: "wie kan bij X en waarom", "certificeer deze toegang", "vind over-privileged identities" | `docs/ui/`, `docs/quickstart.md`, `docs/concepts/` (taakgericht) | **P1** |
| **Operator** | Installeren, configureren, draaien, herstellen | `docs/admin/`, `docs/reference/config.md`, deployment/docker, security, operations | P2 |
| **Contributor** | Meebouwen aan de repo: architectuur, conventies, extensiepunten, tests | `docs/architecture/`, `building-a-crawler.md`, `CLAUDE.md`-files | P2 |
| **API-consument** | Integreert via de API zonder de repo aan te raken: contracten, auth, voorbeelden, fouten, versionering | `docs/api/`, `openapi.yaml`, `docs/reference/sql-views.md` | **P1 voor push/ingest**, anders P2 |

`docs/concepts/` mag de **Contributor**-cel vervullen, maar de **Analyst/Gebruiker**-cel vereist een taak-/schermgerichte gids; een stale concept-doc telt alleen negatief mee bij Contributor.

## Statusrubric (na review)

Twee onafhankelijke dimensies per cel — **coverage** en **trust** — zodat "fout" niet meer in "partieel" verdwijnt:

| Symbool | Betekenis |
|---|---|
| ✅ | Aanwezig **én** voldoet aan de bruikbaarheidsrubric (zie onder) |
| 🟡 | Aanwezig maar onvolledig voor de taak (mist stappen/voorbeelden/prereqs) |
| ⭕ | Ontbreekt |
| ❌ | **Aanwezig maar feitelijk fout / misleidend** — sorteert vóór ⭕ |
| **P0** | ❌ dat misleidend én security/privacy-gevoelig is (bijv. `risky-consent`-egress, foute risk-drempels) → **release-blocking** |
| — | n.v.t. voor deze as |

**Bruikbaarheidsrubric — een cel is pas ✅ als het doc:** accuraat is t.o.v. de baseline-commit · vindbaar is vanuit het logische startpunt · prerequisites vermeldt · uitvoerbare stappen bevat · copy-paste-complete voorbeelden heeft (incl. auth/base-url/verwachte output) · het verwachte resultaat toont · veelvoorkomende foutpaden dekt · onafhankelijk is getest.

## Verificatie-gate (verplicht vóór elk besluit)

De grids zijn **vooraf ingevuld uit een AI-audit en gelden als ONGEVERIFIEERD**. Voordat op een cel een actie (schrijf/fix/werk-bij) wordt besloten:
1. Open het geciteerde codebestand én het geciteerde doc; bevestig het symbool/feit.
2. Markeer de cel `geverifieerd` (met checker + datum) i.p.v. `geërfd`.
3. Stempel de cel met de baseline-commit waartegen geverifieerd is.

*(De review deed dit al voor 2 cellen — tiers=90/70 en `/perf/slow`+`/perf/toggle` — en beide klopten. Verificatie is dus goedkoop, niet overbodig.)*

---

## Instrument B — Journeys (primair)

Kandidaat-journeys (definitief te maken in de eerste sessie). Elk mapt naar de clusters die het raakt en heeft een pass/fail uit een doc-only walkthrough:

| # | Journey (persona) | Raakt clusters | Kern-vraag |
|---|-------------------|----------------|-----------|
| J1 | **Zero-to-first-insight** (Analyst): `docker compose up` → eerste crawler → data op Dashboard → eerste finding in Matrix | 1,7,8,4,2 | Komt een nieuwe evaluator van nul naar eerste inzicht, alleen met docs? |
| J2 | **Beoordeel een risk-score** (Analyst): lees een identity-risk-badge → begrijp de tier → doe een analyst-override | 5,4 | Kan de analist de score begrijpen en erop handelen? |
| J3 | **"Wie kan bij X en waarom"** (Analyst): effective-access / matrix-onderzoek | 2,10,4 | Kan de analist toegang aantonen en verklaren? |
| J4 | **Certificeer toegang** (Analyst): governance/attestatie-flow | 6,4 | Kan een access-review worden voltooid? |
| J5 | **Zet een Entra-crawler op** (Operator): kies phase-toggles bewust | 7,8 | Weet de operator welke toggles nodig zijn en wat elk kost? |
| J6 | **Push data via custom connector** (API-consument): alleen met `docs/api` | 9 | Kan een integrator zonder repo data pushen + key roteren? |
| J7 | **Bouw een crawler** (Contributor): end-to-end vanuit de docs | 7,9,10 | Kan een bijdrager een crawler bouwen alleen met de docs? |
| J8 | **Maak + hergebruik een Context** (Analyst): tree, plugin-run, "Filter matrix" | 3,2 | Werkt het nieuwste, complexste oppervlak end-to-end? |

**Pilot eerst één complexe flow** (aanbevolen door de review) — J8 of J1 — als taakgerichte gids + usability-test, vóór het opschalen van het format.

**Walkthrough-resultatentabel (per journey):**

| Journey | Persona | Voltooid? (j/n) | Eerste blocker | Waar men de docs moest verlaten | Backlog-item |
|---------|---------|-----------------|----------------|----------------------------------|--------------|
| **J1 (pilot, 2026-07-15)** | Analyst/Operator | **NEE** (doc-only) | Entra-setup: `entra-id.md` noemt "vul Tenant/Client ID + Secret" maar niet **welke Graph-permissies** nodig zijn; die lijst staat in `reference/troubleshooting.md` (verkeerd thuis) en `quickstart.md` linkt niet naar `entra-id.md`. (App Registration aanmaken = bekende Entra-kennis, geen doc-gap.) | (1) permissie-lijst → uit troubleshooting halen; (2) dashboard-landingspagina heeft geen doc; (3) Matrix-scopen kan alleen via de ongedocumenteerde Filter-Wizard | BL-1..BL-7 |

**J1-verdict:** demo-pad (Load Demo Data) werkt en is goed gedocumenteerd. Maar het *echte* first-insight-pad faalt doc-only op drie punten: (a) eigen Entra-tenant koppelen vergt de docs verlaten voor de permissielijst; (b) de Dashboard-landingspagina waar je op uitkomt heeft geen gebruikersdoc; (c) de Matrix scopen om een *finding* te bereiken kan alleen via de Filter-Wizard, die niet is gedocumenteerd (overview.md beschrijft nog de verwijderde "User Limit Slider"). Extra bevinding: `index.md` en `quickstart.md` spreken elkaar tegen over of `.env` nodig is.

---

## Prioritering & volgorde (na review)

1. **P0 eerst** — misleidende/security-gevoelige docs (Tier A + `risky-consent`-egress). Fout > ontbrekend.
2. **Dan de first-run journey (J1)** — elke gebruiker raakt dit op dag 1; een gestrande dag-1-gebruiker bereikt Contexts nooit.
3. **Daarna herordenen op journey-impact** = taakfrequentie × schade-bij-fout × centraliteit — **niet** op gap-grootte.

Prio-rubriek per backlog-rij: `doelgroep (P1>P2) × foutheid (❌/P0 > ⭕ > 🟡) × gebruiksfrequentie`.

## Backlog-format (na review)

Per gap een rij met **uitvoerbare** velden:

`feature-ID | doc-type | actie | prio | owner | schatting | doeldoc | definition-of-done | status`

- **Acties:** `schrijf` · `werk-bij` · `fix` · **`reduce/hide/deprecate`** (product zó maken dat de doc niet nodig is) · `accepteer`.
- **`accepteer` vereist:** reden + geraakte persona's/taken + akkoordgever + restrisico + herzien-op-datum. Geen stille drop.
- **Definition-of-done** is gekoppeld aan een taak: *"journey Jx slaagt doc-only"*, niet *"pagina bestaat"*.

## Recurrence / freshness (na review)

- Elke cel stempelen met de **baseline-commit**; staleness wordt zo zichtbaar (edge staat al op v5.443 t.o.v. baseline v5.441).
- **Re-audit-trigger:** een PR die een gelist codepad raakt moet dat clustergrid bijwerken; overweeg de bestaande `openapi.drift.test` uit te breiden naar de read-API en een "docs-touched?"-item in het PR/release-sjabloon. Anders re-rot het grid net als de docs nu (jouw eigen A2).

## Overall exit-criterium

Het geheel is klaar wanneer:
1. **Alle P0/❌** fout-docs zijn gefixt.
2. **Elke persona-journey (J1–J8) slaagt** in een doc-only walkthrough.
3. Geen **⭕ op P1-cellen** (Analyst/Gebruiker + API-consument voor push/ingest).

## Werkwijze per cluster

1. Kies/pin de journey(s) die dit cluster raken.
2. **Verifieer** de grid-cellen die je gaat behandelen (verificatie-gate).
3. Vul de backlog met uitvoerbare rijen (owner + DoD).
4. Voer de walkthrough uit; log blockers.
5. Markeer cluster afgerond zodra zijn journey doc-only slaagt en P1-cellen geen ⭕ meer hebben.

## Voortgang

| # | Cluster / spoor | Status |
|---|-----------------|--------|
| 0 | Niet-feature-docs (getting-started, troubleshooting/errors, concepten "waarom", limitations) | 🔄 deels via J1 (cellen ✔) |
| 1 | Aan de slag & Dashboard | 🔄 in review via J1 (BL-4,5,7) |
| 2 | Matrix | 🔄 in review via J1 (BL-6) |
| 3 | Contexts (scherm + plugins + API) | ⬜ te doen |
| 4 | Entities & detailpagina's | ⬜ te doen |
| 5 | Risk scoring & AI/LLM | ⬜ te doen |
| 6 | Governance / business roles | ⬜ te doen |
| 7 | Sync-bronnen / crawlers | 🔄 in review via J1 (BL-1,2,3) |
| 8 | Admin & instellingen (incl. Admin nav-shell / 10 sub-tabs) | ⬜ te doen |
| 9 | Integratie & ingest-API (**owner van Custom Connector**) | ⬜ te doen |
| 10 | Platform & datamodel (owner van context-**schema**) | ⬜ te doen |
| J | Journeys J1–J8 (primair instrument) | 🔄 **J1 (pilot) uitgevoerd — FAIL doc-only**; J2–J8 te doen |

> **MECE-fixes toegepast:** Custom Connector wordt geownd door **Cluster 9** (stub-referentie in 7). De v6 context-**scherm/API** hoort in Cluster 3, het **schema/tabellen** in Cluster 10. "Alle 10 Admin sub-tabs" krijgt één canonieke rij in Cluster 8. De valse "DevOps"-marketingclaim wordt vastgelegd in Cluster 0 (niet stil gedropt ondanks marketing-out-of-scope).

---

## Cluster 0 — Niet-feature-docs (nieuw, na review)

Code-as-ground-truth mist wat geen feature is maar wél het meest bevraagd wordt.

> **✔ = geverifieerd tegen code/docs op 2026-07-15 (baseline `d4afdb9f`).** Ongemarkeerde cellen zijn nog geërfd uit de audit.

| Categorie | Analyst/Gebruiker | Operator | Contributor | API-consument |
|-----------|:-----------------:|:--------:|:-----------:|:-------------:|
| Getting-started / onboarding (J1) | 🟡 ✔ (demo ok; eigen-tenant faalt) | 🟡 ✔ | — | — |
| Troubleshooting / foutmeldingen ("het synct niet — waarom") | 🟡 ✔ (bestaat, dun/verkeerd thuis) | 🟡 ✔ | 🟡 ✔ | ⭕ ✔ |
| Concepten / "waarom" (mentale modellen) | 🟡 | — | 🟡 | — |
| Limitations / known-issues (incl. valse "DevOps"-bron-claim) | ⭕ | ⭕ | ⭕ | ⭕ |

**Backlog:** _(in te vullen tijdens review)_

---

## Cluster 1 — Aan de slag & Dashboard

| Feature | Analyst/Gebruiker | Operator | Contributor | API-consument |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| Quickstart / eerste crawler | 🟡 | 🟡 | — | — |
| Dashboard-landingspagina | ⭕ | — | 🟡 | — |
| Trends-tab | ⭕ | — | ✅ | — |

**Backlog:**

| ID | Actie | Prio | Owner | Doeldoc | Definition-of-done |
|----|-------|------|-------|---------|--------------------|
| BL-4 | werk-bij: link `entra-id.md` (+ demo vs eigen-tenant keuze) vanuit "What's Next" | P1 | _tbd_ | `docs/quickstart.md` | J1 stap 2: nieuwe user vindt de Entra-setup zonder gokken |
| BL-5 | schrijf: gebruikersdoc Dashboard-landingspagina (cards, counts, "is mijn data binnen?") | P1 | _tbd_ | `docs/ui/` (nieuw) | J1 stap 3: user begrijpt wat hij ziet doc-only |
| BL-7 | fix: `.env`-tegenspraak tussen `index.md` (download `.env.example`) en `quickstart.md` ("just Docker") | P2 | _tbd_ | `docs/index.md` + `docs/quickstart.md` | Eén consistent install-verhaal |

---

## Cluster 2 — Matrix

| Feature | Analyst/Gebruiker | Operator | Contributor | API-consument |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| Basis-view (badges, staircase, DnD, IST-SOLL, export) | 🟡 | — | ✅ | — |
| Filter-Wizard (3-staps + opgeslagen matrices) | ⭕ | — | ⭕ | ⭕ |
| Roll-up-by-attribute | ⭕ | — | ⭕ | — |
| Oriëntatie / geroteerde view | ⭕ | — | ⭕ | — |
| Scope-statistieken | 🟡 | — | ✅ | — |
| Matrix-interactie-endpoints (preview, hierarchy-paths, saved-filters) | — | — | — | ⭕ |

**Backlog:**

| ID | Actie | Prio | Owner | Doeldoc | Definition-of-done |
|----|-------|------|-------|---------|--------------------|
| BL-6 | schrijf Filter-Wizard/saved-matrices/roll-up + fix: verwijder verouderde "User Limit Slider" uit overview.md | P1 | _tbd_ | `docs/ui/overview.md` (+ matrix) | J1 stap 4: analist kan de matrix scopen en een *finding* bereiken doc-only |

---

## Cluster 3 — Contexts (scherm + plugins + API)

| Feature | Analyst/Gebruiker | Operator | Contributor | API-consument |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| Context-model (synced/generated/manual × 4 targets) — *scherm/gedrag; schema→C10* | ⭕ | — | 🟡 (status "not yet implemented") | — |
| Contexts-scherm (tree, drag-reparent, wizard, Filter-matrix) | ⭕ | — | 🟡 (spec mislabeled) | — |
| Plugin-catalogus (10; 5 ongedocumenteerd/mis-benoemd) | ⭕ | ⭕ | 🟡 | — |
| `risky-consent` externe threat-feed-egress | — | **P0** | ❌ | — |
| Tags als context (`contextType='Tag'`) | 🟡 (stale GraphTags-ref) | — | 🟡 | — |
| Admin → Plugins-subtab | ⭕ | ⭕ | 🟡 | — |
| Context write- + plugin-API (`/contexts` writes, `/context-plugins/*`) | — | — | — | ⭕ |

**Backlog:** _(in te vullen tijdens review)_

---

## Cluster 4 — Entities & detailpagina's

| Feature | Analyst/Gebruiker | Operator | Contributor | API-consument |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| Lijst+detail: Principals / Identities / Resources / Systems | 🟡 (stale namen/OrgUnits) | — | ✅ | ✅ |
| Entity-detail-tabs (attrs / graph / timeline / risk) | 🟡 (arch-only) | — | ✅ | — |
| Account-linking | ✅ | — | ✅ | — |
| Secundaire detail-endpoints (contexts/assignments/business-roles/oauth2-grants) | — | — | — | ⭕ |

**Backlog:** _(in te vullen tijdens review)_

---

## Cluster 5 — Risk scoring & AI/LLM

| Feature | Analyst/Gebruiker | Operator | Contributor | API-consument |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| 4-laags engine + risk-tiers | **P0** (cutoffs FOUT) | — | ❌ (cutoffs FOUT) | — |
| Classifiers (generatie-flow) | 🟡 | — | 🟡 (gestubd PS-pad) | — |
| Analyst-overrides | ✅ | — | ✅ | — |
| AI-agent-scoring | 🟡 | — | 🟡 (stale refs) | — |
| LLM-classifier-generatie (Node vs. PS-stub) | — | 🟡 | 🟡 | — |
| Risk-profile/classifier-API (~20 endpoints) | — | — | 🟡 | ⭕ |
| Admin → Risk-Scoring-wizard & LLM-settings | ⭕ | 🟡 | 🟡 | — |

**Backlog:** _(in te vullen tijdens review)_

---

## Cluster 6 — Governance / business roles

| Feature | Analyst/Gebruiker | Operator | Contributor | API-consument |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| Business roles / governed assignments / resource grants | ✅ | — | ✅ | — |
| Certificeringen | 🟡 | — | ✅ | — |
| Assignment-policies / -requests | — | — | ✅ | — |
| IGA-platform-mapping (Entra/Omada/SailPoint) | — | — | ✅ | — |
| Governance-summary / review-compliance-API | — | 🟡 | 🟡 | ⭕ |

**Backlog:** _(in te vullen tijdens review)_

---

## Cluster 7 — Sync-bronnen / crawlers

| Feature | Analyst/Gebruiker | Operator | Contributor | API-consument |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| Entra ID (6 phase-toggles + AI-agent-classificatie) | 🟡 ✔ | 🟡 ✔ (permissies staan in troubleshooting, niet in setup) | ❌ ✔ (diagram toont retired `Owner`-type; 6 toggles ontbreken in flags-tabel) | — |
| Azure RM (`onlyEntraPrincipals`) | 🟡 | 🟡 | ✅ | — |
| midPoint | ✅ | ✅ | 🟡 (streaming/dept dev-only) | — |
| Omada | ✅ | ✅ | ✅ | — |
| CSV-import (nieuwe templates) | 🟡 | 🟡 | 🟡 | — |
| Custom Connector (push-mode) → *owner: Cluster 9* | ↪ C9 | ↪ C9 | ↪ C9 | ↪ C9 |
| Wizard/plugin-architectuur + live discovery | — | — | ✅ | — |

**Backlog:**

| ID | Actie | Prio | Owner | Doeldoc | Definition-of-done |
|----|-------|------|-------|---------|--------------------|
| BL-1 | werk-bij: benoem de **vereiste Graph-permissies** in de setup-sectie (nu alleen in `troubleshooting.md`). App-Registration aanmaken wordt bekend verondersteld → niet documenteren. | P1 | _tbd_ | `docs/sync/entra-id.md` | J5 slaagt doc-only; J1 stap 2 verlaat de docs niet meer voor de permissielijst |
| BL-2 | **fix (❌):** "What Gets Synced"-diagram — verwijder retired `Owner`-assignmenttype; toon ownership als `Direct` op `GroupOwnership` | P1 | _tbd_ | `docs/sync/entra-id.md` | Diagram matcht `assignmentTypes.guard` (Direct/Indirect/Eligible) |
| BL-3 | werk-bij: 6 verscheepte toggles in de flags-tabel (`SyncOAuth2Grants/AppRoles/AppPermissions/AppOwners/PrincipalRelationships/DirectoryRoles`) + AI-agent-classificatie | P2 | _tbd_ | `docs/sync/entra-id.md` | Flags-tabel = crawler-param-block |

---

## Cluster 8 — Admin & instellingen

| Feature | Analyst/Gebruiker | Operator | Contributor | API-consument |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| **Admin nav-shell / 10 sub-tabs (canonieke inventaris-rij)** | ⭕ | 🟡 | 🟡 | — |
| Authentication / Roles & Permissions-editor | ⭕ | 🟡 | 🟡 | — |
| Updates (auto-update, kanaal, historie) | ✅ | ✅ | ✅ | — |
| Data-tab (PowerQuery ✅; curated import/export, retention, danger zone ⭕) | 🟡 | 🟡 | 🟡 | — |
| Performance | ✅ | 🟡 | ❌ (perf-endpoint drift `/perf/slowest`→`/perf/slow`) | ❌ |
| Crawler config audit/reset | — | ⭕ | — | ⭕ |
| About / SBOM / licentie | 🟡 | ✅ | ✅ | — |

**Backlog:** _(in te vullen tijdens review)_

---

## Cluster 9 — Integratie & ingest-API (owner van Custom Connector)

| Feature | Analyst/Gebruiker | Operator | Contributor | API-consument |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| Ingest-API (`/ingest/*`, openapi.yaml) | — | ✅ | ✅ | ✅ |
| **Custom Connector (push-mode) — opzet + kaart** | ⭕ | ⭕ | ✅ | ⭕ |
| API-key-beheer / rotatie / audit | — | 🟡 | ✅ | ⭕ |
| Drift-guard-scope (welke routes bewaakt) | — | — | 🟡 (alleen in test) | — |

**Backlog:** _(in te vullen tijdens review)_

---

## Cluster 10 — Platform & datamodel (owner van context-schema)

| Feature | Analyst/Gebruiker | Operator | Contributor | API-consument |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| Datamodel (v3.1 + v6 contexts, **schema/tabellen**) | — | — | ❌ (collapsed types "in use" / stale) | — |
| Effective-access-engine (P1 direct + P2 inherited) | — | — | ✅ | — |
| Soft-delete | — | 🟡 | ✅ | — |
| Audit-history / timeline | 🟡 | — | ✅ | — |
| Assignment-model-collapse (migraties 044/045) | — | — | ❌ (status "no code yet") | — |
| Deployment / Docker / Azure | — | ✅ | ✅ | — |
| Scaling | — | 🟡 | ✅ | — |

**Backlog:** _(in te vullen tijdens review)_

---

## Review-appendix (dual-voice) {#review-appendix-dual-voice}

Dit plan is geëvolueerd van v1 na een `/autoplan`-review met vier onafhankelijke voices (3 Claude-subagents: strategie/proces/DX + Codex op de echte bestanden). Unanieme kernbevinding: v1 mat aanwezigheid, niet bruikbaarheid.

**Consensus (CONFIRMED door alle voices):**
1. Meet bruikbaarheid, niet enkel aanwezigheid → **Instrument B (journeys)**.
2. Verifieer de AI-vooringevulde grids vóór besluit → **verificatie-gate**.
3. Dek cross-cluster journeys → **J1–J8**.
4. Split Contributor vs API-consument; scherp primaire persona naar Analyst → **4 assen**.
5. Onderscheid *fout* van *ontbrekend* → **❌/P0-status**.
6. Maak de backlog uitvoerbaar (owner/DoD) → **backlog-format**.
7. Voeg niet-feature-docs toe (troubleshooting/concepten/limitations) → **Cluster 0**.
8. Voorkom re-rot → **recurrence/freshness-gate**.
9. MECE-overlaps oplossen → **owner-toewijzing + Cluster 0**.

**Beslissingen (door de gebruiker, 2026-07-15):**
- UC1 — journeys primair, grid ondersteunend: **geaccepteerd**.
- UC2 — 4 assen + Analyst-persona: **geaccepteerd**.

**Auto-besliste methodische fixes** (verificatie-gate, ❌/P0-status, rubric, backlog-DoD, reduce/hide/deprecate-actie, recurrence, exit-criterium, Cluster 0, MECE-owners): toegepast.

**Kanttekening bij de inputs:** de grids hierboven zijn nog steeds **geërfd/ongeverifieerd**; ze passeren de verificatie-gate pas tijdens de clusterreview.
