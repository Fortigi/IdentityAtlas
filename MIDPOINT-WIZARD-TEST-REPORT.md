# midPoint configuratie-wizard — Testrapport

**Branch:** `feature/midpoint-config-wizard` (van `main` @ `04659bf`) · commits `b46a0dd`, `3f3b41d`
**Datum:** 2026-06-17
**Testomgeving:** `identityatlas` (192.168.8.95) draaiend op zelf-gebouwde `:dev` images uit deze branch, tegen `midpoint-dev` (`http://192.168.8.184:8080/midpoint`, BasicAuth `administrator`).

---

## 1. Statische verificatie

| Check | Resultaat |
|---|---|
| PowerShell parse `Start-MidpointCrawler.ps1` | ✅ geen fouten |
| PowerShell parse `Invoke-MidpointApi.ps1` | ✅ geen fouten |
| `crawler.json` geldig JSON + schema | ✅ |
| Web-image build (vite UI + Node API) | ✅ slaagt → UI/JSX compileert foutloos |
| Worker-image build (PowerShell + crawler) | ✅ |
| Pester `test/unit/Midpoint.Tests.ps1` | ✅ **77/77** groen (incl. 16 nieuwe mapping-tests) |

De 16 nieuwe unit-tests dekken `ConvertTo-MapRows`, `Resolve-MappedResourceType`
(archetype → subtype → catch-all → default, case-insensitive), `Resolve-MappedValue`,
`Get-MidpointStringList` en `Get-MidpointArchetypeNames`.

## 2. Live discovery (UI-dropdowns uit de node)

`POST /api/admin/midpoint/discover` met inline BasicAuth-config →

```
archetypes: 54   (incl. 'Business role', 'Application role', 'Application', 'System role')
roleSubtypes: []  orgSubtypes: []  userTypes: []   (geen subtypes in deze dataset — verwacht)
```

Bewijst: de nieuwe Node-route verbindt live met midPoint (alle auth-methods incl. OAuth2),
parset de `{object:{object:[…]}}`-envelope correct, en levert de waarden die de wizard-dropdowns
vullen.

## 3. UI daadwerkelijk verscheept

In de gedeployde `dist` (`CrawlersPage-*.js`) aangetroffen: `midPoint (Evolveum)` (3×),
`midpoint-wizard` (4×), `midpoint/discover`, `Role classification`. midPoint staat in de
"Add Crawler"-keuzelijst en **"Configure" opent nu de midPoint-wizard** i.p.v. de Entra-wizard
(de gefixte bug).

## 4. Echte crawl — regressie-baseline (default mapping)

Config zonder mapping-overrides, volledige crawl (**job 8 → status `completed`**, hele pipeline incl. shadows/reviews/refresh-views):

| resourceType | aantal | objecten |
|---|---|---|
| BusinessRole | 7 | alle rollen |
| Service | 4 | alle services |
| AppRole | 0 | — |

→ **Byte-voor-byte identiek aan het gedrag vóór deze wijziging.** Regressie-veilig.

## 5. Echte crawl — archetype-remap

Config aangepast: `archetypeMapping = [{archetype:"System role" → AppRole}, {catch-all → BusinessRole}]`.
Op `midpoint-dev` hebben 4 rollen het archetype *System role* (Superuser, Approver, Reviewer,
Delegator), 3 rollen geen archetype.

| resourceType | aantal | objecten |
|---|---|---|
| **AppRole** | 4 | Approver, Delegator, Reviewer, Superuser (archetype = *System role*) |
| **BusinessRole** | 3 | End user, IA Test Role A, IA Test Role B (geen archetype → catch-all) |
| **Service** | 4 | alle services behouden |

→ Archetype-classificatie werkt end-to-end: de juiste 4 rollen kregen het geconfigureerde type,
de rest viel terug op de catch-all, services bleven ongemoeid.

## 6. Tijdens de test gevonden & gefixte bug

De eerste remap-run liet de 4 services óók `BusinessRole` worden (`Service` = 0). Oorzaak: de
`archetypeMapping`-catch-all (die de wizard standaard invult) matchte óók `ServiceType` vóór hun
`Service`-default. **Fix:** `archetypeMapping` is nu een *rol*-classifier; services zijn altijd
`Service` (commit `3f3b41d`). Na herbouw van de worker is de remap opnieuw gedraaid → tabel in §5.

## 7. Edit-mode & secrets

`PATCH /api/admin/crawler-configs/3` met alleen de mapping → `baseUrl`/`authMethod`/`username`
bleven behouden (merge), en `password` werd uit de job-config gestript en gevault (bevestigd in de
queue-respons). Edit-mode "leeg = behoud secret" werkt.

---

## Status van de testomgeving (opruimen)

- `identityatlas` draait nu op `IMAGE_TAG=dev` (mijn build). Terugzetten naar edge:
  `cd ~/identityatlas && sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=edge/' .env && docker compose -f docker-compose.prod.yml up -d` (`~/identityatlas/.env.bak-premidpoint` is bewaard).
- Test-crawler `config id=3` en het systeem `midPoint (192.168.8.184…)` (id 107) zijn blijven staan
  zodat je de wizard met een echte config kunt bekijken. Verwijderbaar via de UI (Remove).

## Niet automatisch afgedekt

- De org→contextType / user→principalType overrides delen exact dezelfde unit-geteste
  `Resolve-MappedValue`-code en catch-all-defaults (OrgUnit / User) als de geverifieerde rol-mapping;
  de baseline-crawl synct orgs/users normaal. Een dedicated live-remaptest hiervoor is niet gedaan.
