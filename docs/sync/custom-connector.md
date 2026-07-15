# Custom Connector (Push-Mode Ingest)

A **Custom Connector** lets any system push authorization data into Identity Atlas over HTTP — in any language — without shipping a scheduled crawler. Your integration fetches data from its source, shapes it into Identity Atlas records, and POSTs batches to the [Ingest API](../architecture/ingest-api.md). The API handles validation, bulk merge, scoped delete detection, and audit history. There is no SQL access and no PowerShell requirement — just an API key and an HTTP client.

Use a custom connector when the source system already runs its own export or webhook process and you want it to push directly, rather than have Identity Atlas pull on a schedule. For scheduled pull crawlers, see [Building a Crawler](building-a-crawler.md).

---

## 1. Get an API key

**You cannot mint your own key.** Ingest keys are issued by an administrator — either through the UI or the admin API:

- **UI:** Admin → Crawlers → **Add Crawler** → pick **Custom Connector**. The plaintext key is shown **once** at creation time; copy it immediately.
- **Admin API:** an administrator (holding an Entra ID admin JWT) calls `POST /api/admin/crawlers`, which returns the plaintext key once in the response.

Keys look like `fgc_<random>` — the `fgc_` prefix marks them as crawler tokens (distinct from the Entra ID JWTs the read API uses). Only a salted hash is stored server-side, so a lost key cannot be recovered — it must be rotated (see below). Store the key in a secret vault, never in source control.

!!! note
    An admin can scope your key to specific systems and set an expiry. If a call returns `403`, your key may not have access to the `systemId` in your payload, or may lack the `ingest` permission — ask the administrator who issued it.

---

## 2. Push a batch

Point your connector at the deployment's public base URL. For a proxied/TLS deployment where `PUBLIC_BASE_URL=https://atlas.example.com`, the base is `https://atlas.example.com/api`; a direct local deployment is `http://localhost:3001/api`.

Every request carries `Authorization: Bearer fgc_<key>` and a JSON body of `{ syncMode, records[], systemId? }`. `syncMode` is either `delta` (merge only) or `full` (merge, then delete any in-scope records missing from this batch).

The example below registers a source system. `POST /api/ingest/systems` is the one endpoint that needs no pre-existing `systemId` — its `201` response returns the resolved `systemIds`, which you then pass as `systemId` on the follow-up calls (`/ingest/principals`, `/ingest/resources`, and so on).

```bash
curl -sS -X POST https://atlas.example.com/api/ingest/systems \
  -H "Authorization: Bearer fgc_REPLACE_WITH_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "syncMode": "delta",
        "records": [
          {
            "displayName": "Acme HR",
            "systemType": "CustomHR",
            "enabled": true,
            "syncEnabled": true
          }
        ]
      }'
```

Response — `201 Created`:

```json
{
  "table": "Systems",
  "inserted": 1,
  "updated": 0,
  "deleted": 0,
  "records": 1,
  "durationMs": 42,
  "systemIds": [7]
}
```

`records` echoes the batch size; `inserted`/`updated`/`deleted` report what the merge did. `systemIds` appears only on system-creating calls — capture `systemIds[0]` (here, `7`) and send it as `systemId` on every subsequent entity push. A batch either succeeds as a whole (`201`) or is rejected up front on validation (`400`, with the offending records under `details`) — there is no partial-success `errors[]` array and no `syncId` in a single-batch response.

!!! tip
    Fields you do not map to a core column are preserved automatically in the record's `extendedAttributes` JSON — you do not need to strip your source payload down first.

See the [Ingest API reference](../architecture/ingest-api.md) for the full endpoint list, entity schemas, sync modes, and the accepted `assignmentType` / `relationshipType` values.

---

## 3. Rotate your key

Rotation is **self-service** — you do not need an administrator. `POST /api/crawlers/rotate` with your current key issues a new one and **invalidates the old key immediately**, so switch your stored secret over atomically.

```bash
curl -sS -X POST https://atlas.example.com/api/crawlers/rotate \
  -H "Authorization: Bearer fgc_CURRENT_KEY"
```

Response:

```json
{
  "apiKey": "fgc_NEW_KEY_SHOWN_ONCE",
  "apiKeyPrefix": "fgc_NEW_",
  "rotatedAt": "2026-07-15T09:30:00.000Z",
  "message": "Store this API key securely. The previous key is now invalid."
}
```

Persist `apiKey` to your vault before making any further calls — the old key stops working the moment this call returns. To confirm which connector a key belongs to at any time, call `GET /api/crawlers/whoami`.
