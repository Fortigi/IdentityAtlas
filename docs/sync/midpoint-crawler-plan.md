# midPoint Crawler — Plan & Voortgang

> **Levend document.** Dit is zowel het afgesproken plan (v3) als de voortgangstracker
> die tijdens de uitvoering wordt bijgewerkt. Vink af, log beslissingen, en vul het
> reconciliatierapport in naarmate het bewijs binnenkomt.

**Status:** ✅ **Bewezen werkend** — crawler draait groen end-to-end tegen live midpoint-dev → IdentityAtlas; reconciliatie 9/9; 28 unit-tests groen; mock-integratie groen. Niets naar GitHub gepusht.
**Branch:** `feature/midpoint-crawler` (lokaal, niet gepusht).
**Laatste update:** 2026-06-14 (bewijs compleet).

Legenda: ⬜ todo · 🔄 bezig · ✅ klaar · ⏸️ geblokkeerd/wacht · ❌ mislukt

---

## Toestemmingen (deze sessie, verleend 2026-06-13)
- ✅ **Commando-autonomie:** shell/git/SSH/docker autonoom draaien zonder per-aanroep-goedkeuring.
  (Let op: als de harness-permissiemodus alsnog prompts geeft, kan een allowlist in `.claude/settings.local.json` nodig zijn.)
- ✅ **Seeden + opruimen in midpoint-dev:** fixtures met vaste OID's aanmaken én via `Remove-MidpointTestData` verwijderen.
- ✅ **Volledig autonoom tot bewijs:** doorbouwen/testen/herstellen tot het reconciliatierapport klopt; daarna melden met bewijs.
- ✅ **Credentials staan klaar op de machines/vault:** SSH-config + sleutels aanwezig; midpoint/IA-credentials in vault of lokaal bestand. Ik zoek ze daar zelf op bij "go".

**Blijft gelden:** geen push naar `main`/GitHub zonder expliciete opdracht; geen connectietesten vóór "go".

**Open risico (te bevestigen bij start):** UI-screenshots van `http://identityatlas:3001` kunnen een interactieve Entra-login vereisen. Als dat niet automatiseerbaar is, blijft het API/SQL-gebaseerde reconciliatierapport het primaire bewijs en zijn screenshots best-effort.

---

## Vertrekpunt (waarom dit plan zo is)

Ik moet *aantoonbaar* bewijzen dat de crawler werkt. Kernprincipe: per type een
fixture-set met **vaste OID's** in midpoint-dev seeden, die OID's 1-op-1 hergebruiken
als `id`/`externalId` in Identity Atlas, zodat elk object end-to-end traceerbaar is
(*midPoint-OID → ingest-record → exacte UI-URL*). Sluitstuk = een **reconciliatierapport**
dat "verwacht (geseed) vs. waargenomen (in Identity Atlas)" naast elkaar zet.

---

## 1. Branch
- ✅ `feature/midpoint-crawler` aangemaakt vanaf bijgewerkte `main` (2026-06-14).
- Belief-branch ongemoeid laten. **Geen pushes naar `main`/GitHub** zonder expliciete opdracht.

## 2. Bestanden in `tools/crawlers/midpoint/`
| Bestand | Rol | Status |
|---|---|---|
| `crawler.json` | Manifest: `type:"midpoint"`, `postSyncHooks:["buildContexts"]`, `configSchema` (baseUrl + auth). Geen `dependsOn`. | ⬜ |
| `Invoke-MidpointApi.ps1` | Library: `Connect-MidpointAPI` (Basic Auth + OAuth2-bearer), `Invoke-MidpointSearch` (POST `/{type}/search`, paging `maxSize`/`offset`), `Invoke-MidpointGet`, `Get-MidpointRefOid`. | ⬜ |
| `Start-MidpointCrawler.ps1` | Entry point (4 vaste params). Sync-fasen (§5). | ⬜ |
| `Seed-MidpointTestData.ps1` | Idempotente fixture-seeder: `New-MidpointTestData` / `Remove-MidpointTestData` (§4). | ⬜ |
| `Test-MidpointCrawler.ps1` | CI-integratietest tegen mock midPoint REST-server (`throw`/`exit 1` bij falen). | ⬜ |
| `changes/feature-midpoint-crawler.md` | Changelog-fragment (user-facing). | ⬜ |
| `test/unit/Midpoint.Tests.ps1` | Unit-test (auth + ref-helpers), in lijn met `Omada.Tests.ps1`. | ⬜ |

## 3. Auth (zelf uitzoeken)
- Config ondersteunt **Basic Auth** (default; standaard midPoint REST) én **OAuth2/Bearer**.
- Credentials via crawler-config, versleuteld in de Identity Atlas-vault (zoals Omada).
- ⬜ Definitieve methode vaststellen bij eerste verbinding met midpoint-dev; vastleggen in config-defaults + docs.

## 4. Testdata-seeding in midpoint-dev (fundament van het bewijs)
Idempotent via REST met **vaste OID's**. Eén fixture-set die elk type, elke sync-fase én elke relatie raakt.
Verwachte tellingen + OID's = één gedeelde constante set (gebruikt door seeder én reconciliatierapport).

| Type | Fixtures (vaste OID's) | Dekt | Geseed |
|---|---|---|---|
| `OrgType` | 1 root + 2 children (hiërarchie via `parentOrgRef`) | Orgs→Contexts + hiërarchie | ⬜ |
| `RoleType` | 2 rollen, 1 met `inducement` naar de ander | Roles→Resources + `Contains` | ⬜ |
| `ServiceType` | 1 service | Services→Resources | ⬜ |
| `ResourceType` | 1 dummy connected resource (DummyConnector/CSV) | ResourceType→Systems | ⬜ |
| `UserType` | 3 users, met `assignment` (rol+org) en `linkRef` (shadow) | Users→Identities/Principals, assignments, org-membership | ⬜ |
| `ShadowType` | accounts op dummy resource, gekoppeld aan users | Shadows→Principals + IdentityMembers | ⬜ |

- ⬜ Vaste OID-schema + verwachte aantallen vastleggen als constante.
- ⬜ `Remove-MidpointTestData` ruimt exact dezelfde OID's op (schone herhaalruns).

## 5. Sync-fasen (Midpoint → Identity Atlas)
Elke fase pusht via de ingest-API; midPoint-OID's direct als `id`/`externalId`; scoped-delete bij full-sync.

| # | Fase | Bron → ingest-endpoint | Status |
|---|---|---|---|
| 1 | Systems | `ResourceType` (+ midPoint zelf) → `ingest/systems`; bouw `OID→systemId` | ⬜ |
| 2 | Orgs | `OrgType` → `ingest/contexts` (`OrgUnit`, topo-sort op `parentOrgRef`) | ⬜ |
| 3 | Roles + Services | `RoleType`/`ServiceType` → `ingest/resources` (`BusinessRole`/`Service`) | ⬜ |
| 4 | Users | `UserType` → `ingest/identities` + `ingest/principals` + `ingest/identity-members` | ⬜ |
| 5 | Shadows | `ShadowType` → `ingest/principals` (per `resourceRef`) + link via `linkRef[]` → `ingest/identity-members` | ⬜ |
| 6 | Org-membership | `parentOrgRef`/`orgMembership` → `ingest/context-members` | ⬜ |
| 7 | Assignments | `user.assignment[]` → `ingest/resource-assignments` (`Governed`) | ⬜ |
| 8 | Role-nesting | `inducement`/`roleMembershipRef` → `ingest/resource-relationships` (`Contains`) | ⬜ |

`buildContexts`-hook draait na afloop.

## 6. Bewijscyclus (pas op "go", in deze volgorde)
1. ⬜ Branch + bestanden schrijven; lokaal Pester-quality-gate + mock-integratietest **groen**.
2. ⬜ Crawler-map → **identityatlas-node** (SSH), worker herstarten; "midPoint" zichtbaar in **Admin → Crawlers**.
3. ⬜ Auth naar **midpoint-dev** vaststellen → **`New-MidpointTestData`** draaien (seeden).
4. ⬜ Crawler-config invullen, **sync draaien**.
5. ✅ **Deterministische verificatie** — zie §7 (9/9).
6. ✅ Geïtereerd tot elke fase en relatie klopt.
7. ✅ Changelog-fragment toegevoegd (`changes/feature-midpoint-crawler.md`). **Niets gepusht.**

## 7. Bewijs dat de testdata de werking aantoont (deliverable van stap 6.5)
Drie vormen, alle verankerd op de vaste fixture-OID's:

### (a) Reconciliatierapport — kernbewijs
Tabel "verwacht (geseed) vs. waargenomen (in Identity Atlas)" met de OID als anker.
Elke ✓ = echte controle (ingest-respons-telling + gerichte API/SQL-read op die OID).
Geleverd in het antwoord **én** als geëxporteerd bestand (Markdown/CSV).

Resultaat van de crawl op 2026-06-14 (vaste-OID-suffix `…0000000000XX`). Elke regel geverifieerd met een SQL-read op de exacte OID in de IdentityAtlas-database; ✅ = waargenomen zoals verwacht.

| Fixture (midPoint) | Vaste OID-suffix | Verwacht in Identity Atlas | Waargenomen | OK |
|---|---|---|---|---|
| Org Root + Child A + Child B | …020/021/022 | 3 Contexts (OrgUnit), Child A/B → parent Root | 3 OrgUnit-contexts; Child A→Root, Child B→Root | ✅ |
| Role-A, Role-B | …010/011 | 2 Resources (BusinessRole) | beide als BusinessRole | ✅ |
| Service-1 | …030 | 1 Resource (Service) | als Service | ✅ |
| Alice, Bob, Carol | …001/002/003 | 3 Identities + 3 Principals + 3 IdentityMembers | alle 3 (Identity + midPoint-account + link) | ✅ |
| Alice→Role-A, Bob→Service-1, Carol→Role-B | — | 3 ResourceAssignments `Governed` | exact die 3 | ✅ |
| Role-A → Role-B (inducement) | — | 1 ResourceRelationship `Contains` | …010 → …011 Contains | ✅ |
| Alice∈ChildA, Bob∈ChildB, Carol∈Root | — | 3 ContextMembers (memberType=Identity) | exact die 3 | ✅ |
| Alice + Bob CSV-accounts (shadows) | server-OID | 2 Principals in systeem "IA-Test-CSV-Resource", gelinkt aan de juiste identity | shadow `71e72e52…`→Alice, `8781cbbc…`→Bob, beide in CSV-systeem | ✅ |
| CSV-resource als systeem | …040 | 1 System (systemType Midpoint) | System id 15 "IA-Test-CSV-Resource" | ✅ |

**Crawl-fase-tellingen (run 999008, alle fasen groen):** Contexts 324 (321 sample + 3 test), Resources 7 BusinessRole + 4 Service, Identities/Principals/IdentityMembers 324, Shadows 1639 (1274 gelinkt), ContextMembers 590, Governed-assignments incl. de 3 test, Contains incl. Role-A→Role-B. → "midPoint crawler completed successfully."

### (b) Identity Atlas product-API (zoals de UI de data leest)
- `GET /api/systems` → **IA-Test-CSV-Resource** (2 principals = Alice+Bob shadows) en **midPoint (midpoint-dev:8080)** (324 principals, 11 resources). ✅
- `GET /api/users?search=IA%20Test` → IA Test Alice / Bob / Carol. ✅
- Auth staat uit op de node, dus de UI op `http://identityatlas:3001` is direct te openen om de objecten te bekijken (Systems, Identities, Matrix).

### (c) Tegen-telling aan de bron (midPoint REST)
- midPoint-bron-counts (`/users` 321 sample + 3 test = 324, `/orgs` 321+3=324, `/roles` 5+2=7, `/services` 3+1=4) sluiten aan op de gecrawlde aantallen in IdentityAtlas. ✅

### (d) Unit- & integratietests
- `test/unit/Midpoint.Tests.ps1`: **28/28 groen** (helper-functies, multi-value/PolyString, ref-parsing, fixture-spec, bestandsstructuur).
- Mock-integratie (`Start-MockMidpointServer` + crawler via dispatcher): alle fasen exact +1 → groen. `Test-MidpointCrawler.ps1` draait de admin-API-variant in CI.

---

## Omgeving (ontdekt 2026-06-14)
**midpoint-dev** (SSH `robb@midpoint-dev`):
- midPoint draait als docker-container `robb-midpoint_server-1`, image `evolveum/midpoint:4.9.4-alpine`, poort `8080`, postgres erachter (`robb-midpoint_data-1`). robb zit in de `docker`-groep.
- REST-basis: `http://midpoint-dev:8080/midpoint/ws/rest`. Auth: **Basic** `administrator` / wachtwoord uit container-env `MP_SET_midpoint_administrator_initialPassword` (niet in repo/chat opnemen).
- Bestaande sample-data: users **321**, orgs **321**, roles **5** (built-in), services **3**, resources **5**, shadows **0**. → assert op eigen `Test-*` fixtures met vaste OID's, niet op totalen.
- Connectoren: DatabaseTable, AD-LDAP, **CSV** (`0c3e457f-c7a1-44b4-a481-d14fd188bf91`), LDAP, Async, Manual. Geen in-memory dummy.

**identityatlas** (SSH `identityatlas`, user robb):
- Docker-stack: `identityatlas-web-1` (poort 3001), `identityatlas-worker-1`, `identityatlas-postgres-1` (5432, alleen localhost). Repo op `/home/robb/identityatlas`.
- Crawler-scripts zitten in het **image** op `/app/tools/crawlers` (web + worker), niet gemount → deploy via `docker cp` + container-restart (manifest opnieuw inlezen).
- Built-in worker-key (`fgc_…`) in shared volume-bestand `/data/uploads/.builtin-worker-key` (leesbaar via `docker exec`). Master key: `IDENTITY_ATLAS_MASTER_KEY` in `.env`.

## midPoint REST-vorm (ontdekt 2026-06-14)
- Search: `POST /{type}/search` body `{"query":{"paging":{"maxSize":N,"offset":M}}}`; envelope → lijst op `.object.object` (kan **array of enkel object** zijn — altijd wrappen).
- Single: `GET /{type}/{oid}` → `{"<singular>":{...}}`-wrapper. Create idempotent: `PUT /{type}/{oid}` (add-or-overwrite met vaste OID).
- Velden: `oid`, `name`/`fullName`/`givenName`/`familyName` = **platte strings**, `emailAddress`, `activation.effectiveStatus` (enabled/disabled), `assignment[].targetRef={oid,type,relation}` (type bv. `c:RoleType`/`c:OrgType`/`c:ArchetypeType`), `user.parentOrgRef[]` (org-membership), `linkRef[]` → shadows. Org: `displayName` + `parentOrgRef`. Roles: `displayName`/`inducement`.

## Beslissingen-log
- **Auth:** Basic Auth (bevestigd werkend op midpoint-dev). Config ondersteunt Basic + OAuth2-bearer; default Basic.
- **Shadows:** via **CSV-connector**-resource (Test-fixture) provisionen — testusers krijgen een construction-assignment → midPoint maakt account in CSV + shadow + `linkRef`. Geen externe afhankelijkheid.
- **ServiceType:** → Resources (`resourceType='Service'`), consistent met rollen; matrix toont ze dan als toewijsbare resources.
- **Deploy op node:** `docker cp` crawler-map naar web+worker container + restart (image is prebuilt; geen rebuild nodig voor test).
- **Assert-strategie:** uitsluitend op `Test-*` fixtures met vaste OID's (sample-data is groot).

## Open punten / bevindingen
- ✅ CSV-resource-config: werkend (connectorConfiguration met juiste `@ns`-volgorde via `[ordered]`, bundle-ns `connector-csv`, schemaHandling met `ri:`-attribuut-outbounds). Test-connectie = success, schema gegenereerd, provisioning maakt account + shadow + `linkRef`.
- ✅ `PUT /{type}/{oid}?options=overwrite` met `oid` in de body = idempotent add-or-overwrite in 4.9.
- ⚠️ **Deployment-bevinding (geen crawler-bug):** de web-container op deze node heeft `CRAWLER_MANIFESTS_DIR` niet gezet, dus de Node-API valt terug op de hardcoded `VALID_JOB_TYPES` (`demo,entra-id,csv,omada`) en toont nieuwe crawlers (ook midpoint/custom-connector/odata) niet in "Add Crawler". Voor de proof is de crawler daarom via de dispatcher gedraaid; in CI (image uit de repo) wordt het manifest wél ontdekt. Fix voor productiegebruik op deze node: `CRAWLER_MANIFESTS_DIR=/app/crawlers` zetten op de web-container.
- Shadow-search vereist `?options=raw` (plain search → 500). In de crawler verwerkt.
- Sommige midPoint-velden zijn multi-valued (bv. `emailAddress`); de client neemt de eerste waarde.

## Uitvoerings-logboek (chronologisch)
- 2026-06-13 — Plan v3 vastgelegd. Wacht op "go".
- 2026-06-14 — "go" ontvangen. Branch `feature/midpoint-crawler` aangemaakt. Conventies bestudeerd. Omgeving + midPoint REST-vorm + connectoren ontdekt.
- 2026-06-14 — Crawler (manifest + REST-client + entry point + seeder + mock + tests) geschreven. Iteratief gedebugd tegen live midpoint-dev: array-nesting (leading-comma return), `[string]`-Fallback met `$null`, multi-value velden, lege-batch-400, deterministic-vs-native id-resolutie (assignments via directe `resourceId`/`principalId`), `@ns`-volgorde in resource-JSON, shadow `options=raw`, org-hiërarchie via assignment.
- 2026-06-14 — Eindrun groen; reconciliatie 9/9 (zie §7); 28 unit-tests groen; mock-integratie groen; test-rommel opgeruimd. Bewijs compleet. Niets gepusht.

---

## Referenties
- Crawler-raamwerk: `tools/crawlers/CLAUDE.md`, `docs/sync/custom-crawlers.md`, `docs/architecture/crawler-architecture.md`
- Referentie-crawler: `tools/crawlers/omada/` (IGA via OData)
- Ingest-contract: `app/api/src/ingest/validation.js` (verplichte velden per endpoint)
- midPoint REST: https://docs.evolveum.com/midpoint/reference/master/interfaces/rest/
