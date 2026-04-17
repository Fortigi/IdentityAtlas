# Terminology Dictionary — Volledig sessiedossier

> **Doel van dit document:** alles wat nodig is om deze ontwikkelconversatie in een nieuwe chat te hervatten.  
> Sessiedatum: 17 april 2026  
> Branch: `feature/terminology-dictionary`  
> Commit: `d07c091`

---

## Hoe hervatten in een nieuwe chat

1. Open dit bestand en geef het aan Claude als context
2. Zeg: *"Lees dit sessiedossier en hervat de ontwikkeling van de terminology dictionary voor Identity Atlas"*
3. Verwijs naar de openstaande werksporen onderaan dit document

---

## Project-context

**Identity Atlas** is een Docker-deployed applicatie die autorisatiedata uit Microsoft Graph (en andere systemen via CSV) laadt in een **PostgreSQL**-database en die data toont via een React role-mining UI.

- **Stack:** PowerShell (crawlers) · Node.js/Express (API) · React/Vite/Tailwind (UI) · PostgreSQL 16
- **Repo:** `c:\Users\RobBosma\OneDrive - Fortigi\Documenten\GIT-Fortigi\IdentityAtlas`
- **Hoofd-branch:** `main` — nooit direct committen, altijd via PR
- **Feature-branch:** `feature/terminology-dictionary` — hier staat het dictionary-werk

### Docker-omgeving (lokaal)

Er draaien twee stacks:
- **`temp-*`** — productie-image (`ghcr.io/fortigi/identity-atlas:latest`), gestart vanuit `C:\temp`
- **`identityatlas-web-dev`** — lokale build, handmatig gestart

De lokale dev-container starten/herstarten:
```bash
# Bouwen
docker compose build web

# Stoppen en verwijderen van oude dev-container
docker stop identityatlas-web-dev && docker rm identityatlas-web-dev

# Starten (verbonden aan de bestaande temp-postgres)
docker run -d \
  --name identityatlas-web-dev \
  --network temp_default \
  -p 3001:3001 \
  -e NODE_ENV=production \
  -e USE_SQL=true \
  -e DATABASE_URL="postgres://identity_atlas:identity_atlas_local@temp-postgres-1:5432/identity_atlas" \
  -e AUTH_ENABLED=false \
  -e PORT=3001 \
  identityatlas-web:latest
```

UI beschikbaar op: `http://localhost:3001`  
Auth is uitgeschakeld — alle endpoints zijn openbaar.

### Belangrijke technische conventies

- `db.query()` geeft een pg-resultaatobject; gebruik `.rows` voor de array
- `db.queryOne()` geeft direct de eerste rij (of null)
- UNION met LIMIT in PostgreSQL vereist haakjes: `(SELECT ... LIMIT $1) UNION ALL (SELECT ... LIMIT $1)`
- `RiskClassifiers.version` is **INTEGER** in de database (niet TEXT zoals de migratie suggereert)
- De `isActive`-trigger op `RiskClassifiers` zet automatisch de vorige actieve versie op false bij INSERT met `isActive=true`
- Changelog-fragmenten horen in `changes/<branch-name>.md`, nooit in `CHANGES.md` direct
- Migraties: versioned `.sql` bestanden in `app/api/src/db/migrations/`, worden automatisch uitgevoerd bij containerstart. Hoogste nummer nu: **017**

---

## Probleemstelling

Autorisatienamen (groepen, resources, access packages) bevatten afkortingen, codes en jargon die voor een computer betekenisloos zijn maar voor een business-analist wél. Voorbeelden: `INK`, `proc`, `AP-FIN-CTRL-001`. Het doel is een woordenboek dat die termen ontsluit en koppelt aan bekende business processen en risk classifiers.

---

## Beslissingen uit de Q&A (chronologisch)

### LLM-keuze
- **Ollama / Gemma 4** — lokaal
- Reden: vertrouwelijkheid en privacy — autorisatiedata mag de organisatie niet verlaten
- Implementatie: de bestaande LLM-configuratie in Admin → LLM Settings wordt gebruikt; Ollama werkt als OpenAI-compatible endpoint (`openai` provider, lokaal endpoint)

### Doel van het woordenboek
- **C + aanvullende context:** zowel standalone raadpleegbaar (admins) als input voor de classifier-generator als aanvullende context voor andere LLM-aanroepen

### Beheer
- Admins beheren het woordenboek
- Admin-rol bestaat nog niet als UI-concept → apart werkspoor

### Business process matching
- LLM bepaalt zelf welke gangbare business processen een term aansluit (inkoop, HR, finance, …)
- Aangevuld met `critical_business_processes` uit het bestaande risk profile
- Geen vaste externe taxonomie

### Koppeling aan classifiers
- **Keuze B:** LLM stelt extra patronen voor aan bestaande classifier → admin keurt goed of verwerpt
- Niet automatisch, niet het aanmaken van een nieuwe classifier

### Auto-mining
- Ja — LLM scant bestaande resource- en groepsnamen in de database
- Resultaten landen als `pending` ter review door admin

### Correlaties
- Zowel strikte synoniemen (INK = inkoop, sterkte 1.0) als gerelateerde termen (INK ↔ finance, sterkte 0.6)
- Sterktescore 0.0–1.0 heeft meerwaarde
- LLM stelt voor, admin keurt goed — admin kan ook handmatig toevoegen/corrigeren

### Privacy-grens (web search)
- Externe search API is acceptabel **mits** autorisatienamen en organisatiedata niet mee gaan
- Wat gaat naar buiten: alleen generieke zoektermen (bijv. `"INK business process meaning authorization"`)
- Implementatie: DuckDuckGo Instant Answer API (geen key vereist), uitschakelbaar via `SEARCH_PROVIDER=none`
- **Let op:** de mine-operatie stuurt resource/groepsnamen naar de LLM — bij cloud-LLM verlaten die namen het netwerk. Met Ollama blijft alles lokaal.

---

## Architectuurinzicht (einde sessie — belangrijk voor vervolg)

### De fundamentele spanning

Het **risk profile** is **top-down**: gegenereerd op basis van domeinkennis ("havens-logistiek → procurement, HSE, financiële controle zijn kritisch") — *zonder kennis van de werkelijke data in de database*.

De **dictionary** is **bottom-up**: gebouwd uit de werkelijke autorisatienamen — *beschikbaar pas nadat data geladen is, stapsgewijs*.

### Conclusie: iteratief proces

De koppeling dictionary → classifiers is geen eenmalige stap maar een **terugkoppelingsmechanisme**:

```
Ronde 1:
  Generiek profiel → generieke classifiers → eerste scoring → data zichtbaar

Ronde 2:
  Dictionary gebouwd uit data → classifiers herijkt met org-vocabulaire → betere scoring

Ronde N:
  Dictionary verfijnd → classifiers bijgesteld → scores stabiel
```

### Volgende stap (nog niet gebouwd)

**Classifier-regeneratie met dictionary als context** — niet "patch bestaande classifier" maar:

> "Genereer nieuwe classifiers op basis van hetzelfde profiel, aangevuld met de goedgekeurde woordenboektermen en hun business process-koppelingen."

Dit is een **nieuwe flow in de Risk Scoring wizard**, naast de huidige patch-aanpak. De patch-aanpak blijft beschikbaar als tussentijdse correctie tussen rondes in.

De huidige patch-aanpak heeft een fundamenteel nadeel: het voegt losse patronen toe aan een classifier die gegenereerd is zonder kennis van de org-terminologie. De regeneratie-aanpak bakt de terminologie direct in de nieuwe classifiers — coherenter en robuuster.

---

## Wat er gebouwd is

### Database

| Migratie | Inhoud |
|---|---|
| `016_dictionary.sql` | `DictionaryTerms`, `DictionaryCorrelations`, `DictionaryClassifierLinks` |
| `017_dictionary_apply.sql` | `appliedAt` kolom op `DictionaryClassifierLinks` + index |

**DictionaryTerms:**
- `id`, `term` (uniek), `description`, `businessProcesses` (jsonb array), `source` (manual/mined/llm), `status` (pending/approved/rejected), `createdBy`, `createdAt`, `updatedAt`

**DictionaryCorrelations:**
- `id`, `termId` → `relatedTermId`, `strength` (0.0–1.0), `correlationType` (synonym/related), `source` (llm/manual), `status`, `createdBy`, `createdAt`
- UNIQUE op `(termId, relatedTermId)`, check `termId <> relatedTermId`
- Bidirectioneel opvraagbaar via `WHERE termId=$1 OR relatedTermId=$1`

**DictionaryClassifierLinks:**
- `id`, `termId`, `classifierLabel`, `classifierDomain`, `proposedPatterns` (jsonb), `status`, `reviewedBy`, `reviewedAt`, `createdAt`, `appliedAt`

### Backend

| Bestand | Doel |
|---|---|
| `app/api/src/routes/dictionary.js` | 18 endpoints (zie lijst hieronder) |
| `app/api/src/llm/dictionaryPrompts.js` | LLM-prompts: `enrichTermPrompt`, `correlateTermsPrompt`, `mineTermsPrompt`, `parseJsonResponse` |
| `app/api/src/search/webSearch.js` | DuckDuckGo-wrapper, 5s timeout, graceful fallback |
| `app/api/src/index.js` | `dictionaryRouter` geregistreerd na `correlationRulesetsRouter` |

### Frontend

| Bestand | Doel |
|---|---|
| `app/ui/src/components/DictionaryPage.jsx` | Volledige dictionary-UI |
| `app/ui/src/components/AdminPage.jsx` | Dictionary-tab toegevoegd (lazy-loaded), positie tussen Correlation en LLM Settings |

### API-endpoints

```
GET    /api/admin/dictionary/terms                    lijst / zoeken (?q=&status=&limit=&offset=)
POST   /api/admin/dictionary/terms                    handmatig aanmaken
GET    /api/admin/dictionary/terms/:id                detail + correlaties + classifier links
PUT    /api/admin/dictionary/terms/:id                beschrijving/processen bijwerken
DELETE /api/admin/dictionary/terms/:id                verwijderen (cascade op correlaties + links)
POST   /api/admin/dictionary/terms/:id/status         { status: 'approved'|'rejected' }

GET    /api/admin/dictionary/correlations             lijst (?status=)
POST   /api/admin/dictionary/correlations             handmatig aanmaken
PUT    /api/admin/dictionary/correlations/:id         sterkte / type bijwerken
DELETE /api/admin/dictionary/correlations/:id         verwijderen
POST   /api/admin/dictionary/correlations/:id/status  { status: 'approved'|'rejected' }

GET    /api/admin/dictionary/classifier-links         lijst (?status=)
POST   /api/admin/dictionary/classifier-links/:id/status  { status: 'approved'|'rejected' }

GET    /api/admin/dictionary/summary                  { pendingTerms, pendingCorrelations, unappliedLinks }
POST   /api/admin/dictionary/enrich                   { termId } → LLM beschrijft term, stelt classifier-patronen voor
POST   /api/admin/dictionary/correlate                { termId } → LLM stelt correlaties voor t.o.v. approved termen
POST   /api/admin/dictionary/mine                     { limit? } → LLM extraheert termen uit Resources + Principals
POST   /api/admin/dictionary/apply-classifier-links   samenvoegen goedgekeurde patronen in nieuwe classifier-versie
```

### UI-flow (Admin → Dictionary)

1. **⛏ Mine from data** — LLM scant resource/groepsnamen, voegt termen toe als pending
2. Per term: uitklappen → **✨ Enrich with LLM** → beschrijving + business processes + classifier-link-voorstel
3. ✓ Accept / ✕ Reject per classifier-link
4. **⚡ Apply X links to classifier** (verschijnt als `unappliedLinks > 0`) → nieuwe classifier-versie
5. Risk scoring uitvoeren → scores bijgewerkt

### Volledige keten (getest en werkend)

```
POST /api/admin/dictionary/apply-classifier-links
→ { ok: true, appliedCount: 2, skippedCount: 0, newClassifierId: 2 }

POST /api/risk-scoring/runs
→ { id: 5, classifierId: 3, status: 'completed', totalEntities: 42 }
```

---

## Openstaande werksporen

| # | Onderwerp | Omschrijving | Prioriteit |
|---|---|---|---|
| 1 | **Classifier-regeneratie met dictionary** | Nieuwe flow: "Genereer classifiers opnieuw met hetzelfde profiel + goedgekeurde dictionary-termen als aanvullende context". Knop in Risk Scoring wizard. Dit is de architectureel correcte aanpak vs. de huidige patch. | Hoog |
| 2 | **Admin-rol** | Beheer van het woordenboek veronderstelt een admin-rol die in de UI nog niet bestaat. | Parallel |
| 3 | **Bronvermelding in risk scores** | In `riskClassifierMatches` aangeven welk patroon afkomstig is uit een dictionary-term (bijv. "patroon `\bINK\b` afkomstig uit Dictionary-term INK"). | Medium |
| 4 | **Correlaties als LLM-context** | Goedgekeurde synoniemen meegeven als aanvullende context bij andere LLM-aanroepen (bijv. bij enrich: "INK is synoniem voor inkoop en procurement"). | Toekomst |
| 5 | **Web search verbeteren** | DuckDuckGo Instant Answer API is beperkt. Optioneel configureerbare search-provider (Brave Search / SerpAPI) voor betere resultaten. | Toekomst |
