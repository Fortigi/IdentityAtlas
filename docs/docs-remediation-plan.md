# Documentation Remediation Plan v2 (living document)

> **Purpose:** Vaststellen of de IdentityAtlas-documentatie (a) **compleet** is t.o.v. verscheepte features én (b) **bruikbaar** is voor de gestelde doelen — en de gaten gestructureerd wegwerken. Voortbouwend op [`docs-gap-audit.md`](docs-gap-audit.md).
> **Basis:** edge (`main` @ `d4afdb9f`, v5.441). **Branch:** `feature/docs-gap-audit` (lokaal).
> **v2-wijziging (na dual-voice review):** bruikbaarheid wordt gemeten met **journey-walkthroughs (primair instrument)**; het coverage-grid is **ondersteunend inventaris**. Zie de [Review-appendix](#review-appendix-dual-voice) onderaan.
> **Uitvoering (2026-07-15):** alle **34 backlog-items (BL-1..BL-34) toegepast** — 20 docs bijgewerkt + 6 nieuwe gidsen (dashboard, contexts, effective-access, custom-connector, data-tab, authentication), in de mkdocs-nav gehangen. Zie de changelog-fragment `changes/docs-gap-audit.md`.
> **Reconciliatie (2026-07-16):** heraudit tegen `main` na de 34-item-run. Twee Tier-A-lekken bleven staan en zijn nu gefixt: de risk-tier-tabel in `docs/api/risk-scores.md` (stond nog op `Critical ≥80`; code = `≥90/≥70` — audit A1, buiten de oorspronkelijke BL-11/12-scope) en de plugin-catalogus in `context-redesign.md §4.2` (miste 5 verscheepte plugins, noemde `department-tree` fout, en lijstte de nooit-verscheepte `app-grouping-by-pattern`/`business-process-llm` — audit A4). A3 (`/perf/slowest`→`/perf/slow`) is gefixt in #804 (samen met #802/#803).

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
| J9 | **Administreer de deployment** (Operator): Admin-panel, Auth/Roles, export, retention, danger-zone | 8 | Kan een operator de app beheren doc-only? |
| J10 | **Begrijp + query het datamodel** (Contributor): schema, geldige enums, SQL-views | 10 | Kan een contributor het datamodel begrijpen én querien doc-only? |

**Pilot eerst één complexe flow** (aanbevolen door de review) — J8 of J1 — als taakgerichte gids + usability-test, vóór het opschalen van het format.

**Walkthrough-resultatentabel (per journey):**

| Journey | Persona | Voltooid? (j/n) | Eerste blocker | Waar men de docs moest verlaten | Backlog-item |
|---------|---------|-----------------|----------------|----------------------------------|--------------|
| **J1 (pilot, 2026-07-15)** | Analyst/Operator | **NEE** (doc-only) | Entra-setup: `entra-id.md` noemt "vul Tenant/Client ID + Secret" maar niet **welke Graph-permissies** nodig zijn; die lijst staat in `reference/troubleshooting.md` (verkeerd thuis) en `quickstart.md` linkt niet naar `entra-id.md`. (App Registration aanmaken = bekende Entra-kennis, geen doc-gap.) | (1) permissie-lijst → uit troubleshooting halen; (2) dashboard-landingspagina heeft geen doc; (3) Matrix-scopen kan alleen via de ongedocumenteerde Filter-Wizard | BL-1..BL-7 |

| **J8 (2026-07-15)** | Analyst | **NEE** (doc-only) | Er is **geen** gebruikersgids voor het Contexts-scherm; `overview.md` noemt Contexts niet. De enige docs (`context-redesign.md` + `context-redesign-ui.md`) zijn architecture-specs met kop **"not yet implemented"** terwijl de feature live is → misleidend. | Direct — de analist heeft geen enkele stap-gids en moet volledig op de UI zelf terugvallen | BL-8, BL-9, BL-10 |
| **J2 (2026-07-15)** | Analyst | ⚠️ PARTIAL | Stappen zijn gedocumenteerd, maar `risk-scoring/overview.md`+`design.md` geven **foute tier-grenzen** (Critical ≥80/High ≥60 i.p.v. code ≥90/≥70; Medium-boven ook fout). `ui/overview.md` is juist maar spreekt ze tegen → analist mist-classificeert elke badge. | Voor de *juiste* tier-betekenis moet men `tiers.js` lezen | BL-11, BL-12, BL-13 |
| **J3 (2026-07-15)** | Analyst | ⚠️ PARTIAL | "Wie kan bij X" *direct* lukt; *effective/inherited access* bestaat alleen als design-spec, endpoints staan in geen API-ref, geen taakgids. `matrix.md` leert nog retired `O`-badge; `api/matrix.md`+`entities.md` noemen v4-relikwie `mat_UserPermissionAssignments`. | Om het badge-model + effective-access te resolven moest men migraties + `engine.js` lezen | BL-14, BL-15, BL-16 |
| **J4 (2026-07-15)** | Analyst/Reviewer | **NEE** (doc-only) | Geen product-surface om een certificering *uit te voeren* (read-only mirror), en de docs zeggen dat niet. Bovendien gebruiken `governance-model.md`+`api/governance.md` het **retired `assignmentType='Governed'`** (sinds mig 047 een boolean-flag) en verkeerde tabelnamen (`GraphCategories`→`GovernanceCategories`). **Weerlegt audit** (die noemde governance "goed gedekt"). | Om "hoe leg ik een besluit vast" te vinden moest men `routes/` grep'en | BL-17, BL-18, BL-19 |
| **J5 (2026-07-15)** | Operator | ⚠️ PARTIAL | Setup-flow (wizard) ís gedocumenteerd, maar bewuste **toggle-keuze** faalt: 6 verscheepte toggles ontbreken in de flags-tabel (BL-3), geen "welke toggle voor welk doel"-hulp, permissies elders (BL-1), diagram fout (BL-2). | Voor toggle-effecten + permissies moet men de docs verlaten | BL-1, BL-2, BL-3, BL-20 |
| **J6 (2026-07-15)** | API-consument | ⚠️ PARTIAL | *Roteren* lukt; *eerste record pushen* faalt end-to-end: geen `docs/sync/custom-connector.md`, geen runnable `curl` onder `docs/api/` (enige zit in `app/api/CLAUDE.md`), en `ingest-api.md` is stale (response-shape + `assignmentType`-enum lijst retired waarden → 400). | Voor een key + echte payload/response moet men handler + `openapi.yaml` lezen | BL-21, BL-22, BL-23 |
| **J7 (2026-07-15)** | Contributor | ✅ **PASS** | Geen — een contributor kan doc-only een crawler scaffolden vanuit `building-a-crawler.md` (+ architecture + CLAUDE.md). Alleen 2 kleine cross-doc-tegenstrijdigheden (stale `getConfigSecret`-signatuur; wizard-import-stijl). | Nergens (alleen cross-check bij 2 tegenstrijdigheden) | BL-24, BL-25, BL-26 |
| **J9 (2026-07-15)** | Operator | **NEE** (doc-only) | Alleen Auth/Roles (stap b) lukt doc-only. `overview.md` noemt **3** admin-subtabs i.p.v. **10**; de **Data**-tab (export/retention/danger-zone) bestaat nergens in de docs, en `audit-history.md` verwijst naar een niet-bestaande "History Retention"-subtab. | Voor 6 van de 10 tabs + retentie + danger-zone moest men `adminTabs.js`/`maintenance.js`/`curatedData.js` lezen | BL-31, BL-32, BL-33, BL-34 |
| **J10 (2026-07-15)** | Contributor | ⚠️ PARTIAL | Schema + geldige enums begrijpen lukt (`data-model.md` is juist — audit-verdenking onterecht). Maar *querien* faalt: `sql-views.md`-voorbeelden selecteren niet-bestaande kolommen, noemen matviews "planned" (zijn gematerialiseerd sinds mig 013), en `assignment-model-redesign.md` zegt nog "no code yet". | Voor de echte view-kolommen moest men de migraties lezen | BL-27, BL-28, BL-29, BL-30 |

**J8-verdict:** direct FAIL. Een primair, altijd-zichtbaar tabblad (Contexts) heeft nul gebruikersdocumentatie, en de enige bestaande docs claimen dat de feature niet bestaat. Dit is de scherpste bevestiging van audit-bevinding A2 + B1, nu via de journey-lens: het grid alleen zou dit als "🟡 spec bestaat" kunnen lezen; de journey laat zien dat de spec de gebruiker actief misleidt.

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
2. **Elke persona-journey (J1–J10) slaagt** in een doc-only walkthrough.
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
| 1 | Aan de slag & Dashboard | ✅ fixes toegepast — via J1 (BL-4,5,7) |
| 2 | Matrix | ✅ fixes toegepast — via J1+J3 (BL-6,14,15,16) |
| 3 | Contexts (scherm + plugins + API) | ✅ fixes toegepast — via J8 (BL-8,9,10) |
| 4 | Entities & detailpagina's | ⬜ te doen (geraakt door J2/J3/J4; bevindingen in 2/5/6) |
| 5 | Risk scoring & AI/LLM | ✅ fixes toegepast — via J2 (BL-11,12,13) |
| 6 | Governance / business roles | ✅ fixes toegepast — via J4 — **weerlegt audit** (BL-17,18,19) |
| 7 | Sync-bronnen / crawlers | ✅ fixes toegepast — via J1+J5+J7 (BL-1,2,3,20,24,25,26) |
| 8 | Admin & instellingen (incl. Admin nav-shell / 10 sub-tabs) | ✅ fixes toegepast — via J9 (BL-31,32,33,34) |
| 9 | Integratie & ingest-API (**owner van Custom Connector**) | ✅ fixes toegepast — via J6 (BL-21,22,23) |
| 10 | Platform & datamodel (owner van context-**schema**) | ✅ fixes toegepast — via J10 (BL-27,28,29,30) |
| J | Journeys J1–J10 (primair instrument) | ✅ **alle 10 uitgevoerd** — J7 PASS · J2/J3/J5/J6/J10 PARTIAL · J1/J4/J8/J9 FAIL (doc-only) |

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
| Basis-view (badges, staircase, DnD, IST-SOLL, export) | 🟡 | — | ❌ ✔ (`matrix.md` leert retired `O`-badge; `api/*` noemt v4-relikwie `mat_UserPermissionAssignments`) | — |
| Filter-Wizard (3-staps + opgeslagen matrices) | ⭕ | — | ⭕ | ⭕ |
| Roll-up-by-attribute | ⭕ | — | ⭕ | — |
| Oriëntatie / geroteerde view | ⭕ | — | ⭕ | — |
| Scope-statistieken | 🟡 | — | ✅ | — |
| Matrix-interactie-endpoints (preview, hierarchy-paths, saved-filters) | — | — | — | ⭕ |

**Backlog:**

| ID | Actie | Prio | Owner | Doeldoc | Definition-of-done |
|----|-------|------|-------|---------|--------------------|
| BL-6 | schrijf Filter-Wizard/saved-matrices/roll-up + fix: verwijder verouderde "User Limit Slider" uit overview.md | P1 | _tbd_ | `docs/ui/overview.md` (+ matrix) | J1 stap 4: analist kan de matrix scopen en een *finding* bereiken doc-only |
| BL-14 | schrijf taakgids "Wie kan bij resource X, en waarom" (direct + inherited holders + access-path) | P1 | _tbd_ | `docs/guides/effective-access-howto.md` (nieuw) | J3: analist beantwoordt "wie + waarom" doc-only |
| BL-15 | werk-bij: documenteer effective-access-endpoints (`GET /resource/:id/effective-access`, `/principal/:id/…`, `POST /effective-access/resolve`) | P1 | _tbd_ | `docs/api/matrix.md` | Endpoints vindbaar buiten de design-spec |
| BL-16 | fix stale badge-tabel (drop `O`/`Governed`, voeg DirectoryRole(Eligible) toe) + vervang `mat_UserPermissionAssignments` door `vw_ResourceUserPermissionAssignments` | P2 | _tbd_ | `docs/architecture/matrix.md` + `docs/api/matrix.md` + `docs/api/entities.md` | Geen doc spreekt het 3-badge-model tegen; geen v4-relikwie |

---

## Cluster 3 — Contexts (scherm + plugins + API)

| Feature | Analyst/Gebruiker | Operator | Contributor | API-consument |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| Context-model (synced/generated/manual × 4 targets) — *scherm/gedrag; schema→C10* | ⭕ ✔ | — | ❌ ✔ (spec zegt "not yet implemented" — misleidend) | — |
| Contexts-scherm (tree, drag-reparent, wizard, Filter-matrix) | ⭕ ✔ | — | ❌ ✔ (spec zegt "not yet implemented") | — |
| Plugin-catalogus (10; 5 ongedocumenteerd/mis-benoemd) | ⭕ | ⭕ | 🟡 | — |
| `risky-consent` externe threat-feed-egress | — | **P0** | ❌ | — |
| Tags als context (`contextType='Tag'`) | 🟡 (stale GraphTags-ref) | — | 🟡 | — |
| Admin → Plugins-subtab | ⭕ | ⭕ | 🟡 | — |
| Context write- + plugin-API (`/contexts` writes, `/context-plugins/*`) | — | — | — | ⭕ |

**Backlog:**

| ID | Actie | Prio | Owner | Doeldoc | Definition-of-done |
|----|-------|------|-------|---------|--------------------|
| BL-8 | **fix (❌):** verwijder "not yet implemented"-status uit beide context-specs; markeer als geïmplementeerd (A2) | P1 | _tbd_ | `docs/architecture/context-redesign.md` + `context-redesign-ui.md` | Status matcht de verscheepte code |
| BL-9 | schrijf: Analyst-gebruikersgids Contexts-scherm (tree, synced/generated/manual, New-Context-wizard, Run now, "Filter matrix") | P1 | _tbd_ | `docs/ui/` (nieuw) | J8 slaagt doc-only |
| BL-10 | werk-bij: `overview.md` nav-lijst — voeg Contexts toe, verwijder verwijderde "Org Chart" (findability) | P1 | _tbd_ | `docs/ui/overview.md` | Nieuwe user vindt het Contexts-tabblad via de docs |

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

**Backlog (via J2):**

| ID | Actie | Prio | Owner | Doeldoc | Definition-of-done |
|----|-------|------|-------|---------|--------------------|
| BL-11 | **fix (P0):** tier-grenzen → Critical 90–100, High 70–89, Medium 40–69 (matcht `tiers.js`) | P0 | _tbd_ | `docs/risk-scoring/overview.md` | Analist leidt uit overview.md dezelfde tier af als de badge toont |
| BL-12 | **fix (P0):** zelfde tier-correctie | P0 | _tbd_ | `docs/risk-scoring/design.md` | Geen doc noemt een cutoff die `tiers.js` tegenspreekt |
| BL-13 | werk-bij: override = geheel getal −50..+50, reden 3–500 tekens | P2 | _tbd_ | `docs/risk-scoring/overview.md` | Analist krijgt geen onverklaarbare 400 |

---

## Cluster 6 — Governance / business roles

| Feature | Analyst/Gebruiker | Operator | Contributor | API-consument |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| Business roles / governed assignments / resource grants | 🟡 ✔ | — | ❌ ✔ (docs gebruiken retired `assignmentType='Governed'`; sinds mig 047 een boolean-flag) | — |
| Certificeringen (uitvoeren) | ❌ ✔ (docs impliceren een flow; product is read-only mirror) | — | 🟡 ✔ | — |
| Assignment-policies / -requests | — | — | ✅ | — |
| IGA-platform-mapping (Entra/Omada/SailPoint) | — | — | ✅ | — |
| Governance-summary / review-compliance-API | — | 🟡 ✔ | 🟡 ✔ (tabelnamen `GraphCategories`→`GovernanceCategories` fout; endpoints niet in api/governance.md) | ⭕ ✔ |

**Backlog (via J4 — weerlegt audit "governance goed gedekt"):**

| ID | Actie | Prio | Owner | Doeldoc | Definition-of-done |
|----|-------|------|-------|---------|--------------------|
| BL-17 | schrijf: "Identity Atlas **rapporteert over** maar **voert geen** certificeringen uit — besluiten vallen in de bron-IGA (Entra Access Reviews) en worden read-only gespiegeld"; + waar de reviewer wél kijkt | P0 | _tbd_ | `docs/concepts/governance-model.md` + `docs/ui/overview.md` | J4: reviewer weet doc-only waar besluiten vallen; geen dead-end |
| BL-18 | **fix (P0):** verwijder retired `assignmentType='Governed'` overal; vervang door `governed=true`-flag | P0 | _tbd_ | `docs/api/governance.md` + `docs/concepts/governance-model.md` | Grep op `'Governed'` als type = 0; matcht mig 047 + ingest-guard |
| BL-19 | fix tabelnamen (`GovernanceCategories`) + documenteer `GET /governance/summary` & `/review-compliance` | P1 | _tbd_ | `docs/api/governance.md` | Namen + endpoints matchen code |

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
| BL-20 (J5) | schrijf: "welke toggle voor welk doel"-keuzehulp (wanneer SP's/PIM/app-roles/owners aanzetten + kosten) | P2 | _tbd_ | `docs/sync/entra-id.md` | Operator kiest bewust de juiste toggles doc-only |
| BL-24 (J7) | **fix:** stale `getConfigSecret`-signatuur `(crawlerId, key)` → `(configId)` (matcht `crawlerSecrets.js`) | P2 | _tbd_ | `tools/crawlers/CLAUDE.md` (~r178) | Contributor roept `getConfigSecret` correct aan |
| BL-25 (J7) | fix: wizard-import-stijl → `@ui/`-alias i.p.v. `../../../app/ui/src/…`-traversal (twee docs spreken elkaar tegen) | P2 | _tbd_ | `docs/sync/building-a-crawler.md` | Beide crawler-docs leren dezelfde import-conventie |
| BL-26 (J7) | werk-bij: minimal-voorbeeld dot-source `shared/Invoke-CrawlerIngest.ps1` (`Update-CrawlerProgress`) i.p.v. hand-rolled | P3 | _tbd_ | `docs/sync/building-a-crawler.md` | Voorbeeld matcht de "dot-source shared helpers"-regel |

---

## Cluster 8 — Admin & instellingen

| Feature | Analyst/Gebruiker | Operator | Contributor | API-consument |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| **Admin nav-shell / 10 sub-tabs (canonieke inventaris-rij)** | ❌ ✔ **P0** (overview noemt 3, echt 10; Data-tab ontbreekt) | ❌ ✔ | 🟡 | — |
| Authentication / Roles & Permissions-editor | ⭕ (geen UI-walkthrough) | ✅ ✔ (`permissions.md` dekt rol→permissie + bootstrap/lockout) | 🟡 | — |
| Updates (auto-update, kanaal, historie) | ✅ | ✅ | ✅ | — |
| Data-tab (PowerQuery ✅; curated import/export ⭕, retention ⭕, danger zone ⭕) | 🟡 ✔ | ⭕ ✔ | 🟡 | — |
| Performance | ✅ | 🟡 | ❌ (perf-endpoint drift `/perf/slowest`→`/perf/slow`) | ❌ |
| Crawler config audit/reset | — | ⭕ | — | ⭕ |
| About / SBOM / licentie | 🟡 | ✅ ✔ (permissie-catalogus klopt) | ✅ | — |

**Backlog (via J9):**

| ID | Actie | Prio | Owner | Doeldoc | Definition-of-done |
|----|-------|------|-------|---------|--------------------|
| BL-31 | **fix (P0):** Admin-subtab-inventaris — vervang "3 tabs" door alle 10 uit `adminTabs.js`, elk met doel + gating-permissie | P0 | _tbd_ | `docs/ui/overview.md` | J9 stap a: operator vindt elke tab doc-only |
| BL-32 | **schrijf (P0):** Data-tab-gids — curated export/import (gates), history-retention (180d default, 0=uit), Danger Zone/clean-database (wat wist/behoudt, rate-limit, `admin.systems`) | P0 | _tbd_ | `docs/admin/data-tab.md` (nieuw) | J9 stap c+d doc-only |
| BL-33 | fix: retentie-pad — `Admin > History Retention` bestaat niet → "sectie onder Admin → Data" | P1 | _tbd_ | `docs/architecture/audit-history.md` (~r132) | Geen doc verwijst naar niet-bestaande subtab |
| BL-34 | werk-bij: Authentication/SSO + Roles-setup als stap-voor-stap how-to (nu alleen reference-proza) | P2 | _tbd_ | `docs/admin/authentication.md` (nieuw) of `permissions.md` | J9 stap b heeft een gelinkte how-to |

---

## Cluster 9 — Integratie & ingest-API (owner van Custom Connector)

| Feature | Analyst/Gebruiker | Operator | Contributor | API-consument |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| Ingest-API (`/ingest/*`, openapi.yaml) | — | ✅ | ✅ (openapi) | 🟡 ✔ (`ingest-api.md` stale: response-shape + retired `assignmentType`-enum → 400) |
| **Custom Connector (push-mode) — opzet + kaart** | ⭕ | ⭕ ✔ | ✅ | ⭕ ✔ (geen runnable voorbeeld onder `docs/api/`) |
| API-key-beheer / rotatie / audit | — | 🟡 ✔ (roteren lukt; key *verkrijgen* niet zelf-service) | ✅ | 🟡 ✔ |
| Drift-guard-scope (welke routes bewaakt) | — | — | 🟡 (alleen in test) | — |

**Backlog (via J6):**

| ID | Actie | Prio | Owner | Doeldoc | Definition-of-done |
|----|-------|------|-------|---------|--------------------|
| BL-21 | schrijf push-mode integrator-gids: "key krijg je van een admin / Admin→Crawlers (niet zelf-mint)" + één runnable `curl` (base-url, `Bearer fgc_…`, echte payload, `201`-response) + rotate-snippet | P1 | _tbd_ | `docs/sync/custom-connector.md` (nieuw) | J6 start-tot-eind doc-only walkbaar |
| BL-22 | **fix:** stale response + enum-tabellen (response zonder `syncId`/`errors`; `assignmentType` = alleen Direct/Indirect/Eligible; huidige relationshipTypes) | P1 | _tbd_ | `docs/architecture/ingest-api.md` | Doc matcht `handlers.js` + `openapi.yaml` |
| BL-23 | werk-bij: één autoritatieve externe base-URL (`PUBLIC_BASE_URL`) voor proxied/TLS | P2 | _tbd_ | `docs/api/index.md` | Integrator kent de juiste base-URL |

---

## Cluster 10 — Platform & datamodel (owner van context-schema)

| Feature | Analyst/Gebruiker | Operator | Contributor | API-consument |
|---------|:-----------------:|:--------:|:-----------:|:-------------:|
| Datamodel (v3.1 + v6 contexts, **schema/tabellen**) | — | — | ✅ ✔ (`data-model.md` correct; assignmentType-collapse klopt — audit-verdenking onterecht) | — |
| **SQL-views (query-surface)** | — | — | ❌ ✔ (voorbeelden selecteren niet-bestaande kolommen; matviews als "planned") | 🟡 ✔ |
| Effective-access-engine (P1 direct + P2 inherited) | — | — | ✅ | — |
| Soft-delete | — | 🟡 | ✅ | — |
| Audit-history / timeline | 🟡 | — | ✅ | — |
| Assignment-model-collapse (migraties 044–049) | — | — | ❌ ✔ (status "no code yet" — is verscheept) | — |
| Deployment / Docker / Azure | — | ✅ | ✅ | — |
| Scaling | — | 🟡 | ✅ | — |

**Backlog (via J10):**

| ID | Actie | Prio | Owner | Doeldoc | Definition-of-done |
|----|-------|------|-------|---------|--------------------|
| BL-27 | **fix:** herschrijf alle voorbeeld-queries tegen echte kolommen (`membershipType`/`path`/`userId`/`businessRoleId`/`managedByAccessPackage`); lijst per view de echte output-kolommen | P1 | _tbd_ | `docs/reference/sql-views.md` | Elk voorbeeld draait ongewijzigd op een gemigreerde DB |
| BL-28 | **fix:** matview-status — `vw_ResourceUserPermissionAssignments` + `vw_UserPermissionAssignmentViaBusinessRole` zijn *materialized* (need `REFRESH`); schrap "planned for a future release" | P1 | _tbd_ | `docs/reference/sql-views.md` | Geen "standard view"/"planned"-taal; refresh gedocumenteerd |
| BL-29 | werk-bij: status-header "Proposed / no code yet" → "Implemented" + migratie-range 044–049 | P2 | _tbd_ | `docs/architecture/assignment-model-redesign.md` | Status matcht verscheepte code |
| BL-30 | fix: waarde-lijst in de `vw_ResourceUserPermissionAssignments`-rij (drop `Owner`/`CrossResourceIndirect`; kolom = `membershipType`) | P2 | _tbd_ | `docs/reference/sql-views.md` | Waarden = view-`CASE`-output |

---

## Review-appendix (dual-voice) {#review-appendix-dual-voice}

Dit plan is geëvolueerd van v1 na een `/autoplan`-review met vier onafhankelijke voices (3 Claude-subagents: strategie/proces/DX + Codex op de echte bestanden). Unanieme kernbevinding: v1 mat aanwezigheid, niet bruikbaarheid.

**Consensus (CONFIRMED door alle voices):**
1. Meet bruikbaarheid, niet enkel aanwezigheid → **Instrument B (journeys)**.
2. Verifieer de AI-vooringevulde grids vóór besluit → **verificatie-gate**.
3. Dek cross-cluster journeys → **J1–J10**.
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
