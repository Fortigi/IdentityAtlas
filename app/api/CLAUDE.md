# Node.js API — Coding Guide

## Always Test Locally Before Committing

After any change to the API, rebuild the container and verify the fix before touching git:

```bash
docker compose build web && docker compose up -d web
# then hit a representative endpoint, e.g.:
curl -s -X POST http://localhost:3001/api/ingest/contexts \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"records":[{"id":"...","contextType":"Department","displayName":"Test","systemId":1}],"syncMode":"full","systemId":1}'
```

Only proceed to branch/commit/push once the endpoint returns a 2xx response. The prod compose file (`docker-compose.prod.yml`) uses a pre-built image from ghcr.io — source file changes have no effect until the image is rebuilt with `docker compose build`.

## Database Schema

**Never modify the schema manually.** All schema changes go through versioned migration files in `app/api/src/db/migrations/`. The web container applies them automatically at startup.

Migration files are numbered sequentially (`001_core_schema.sql`, `002_governance.sql`, etc.). Add a new file for each schema change — never edit existing migration files.

## Key Patterns

- **Column cache:** Use `db/columnCache.js` for column discovery — it has a 5-minute TTL. Don't run `information_schema` queries per-request.
- **Connection pool:** Always use the pool from `db/connection.js`. Never create one-off connections.
- **Error responses:** Return generic messages to clients. Log `err.message` server-side, not the full error object (avoids leaking schema info).
- **Input validation:** Validate IDs with `parseInt(..., 10)` + `isNaN()` check. Validate hex colors with `/^#[0-9a-fA-F]{6}$/`. Cap array inputs at 500 items.
- **SQL parameters:** Always use parameterized queries. Never interpolate user input into SQL strings.

## Route Files

| File | Responsibility |
|------|---------------|
| `routes/permissions.js` | Permissions, AP groups, sync log |
| `routes/categories.js` | Category CRUD, AP list, category assignments |
| `routes/details.js` | User/group/resource detail endpoints with history |
| `routes/resources.js` | Resource CRUD, filtering, column discovery |
| `routes/systems.js` | Systems CRUD, owners, statistics |
| `routes/identities.js` | Identity correlation results |
| `routes/riskScores.js` | Risk score reading + analyst override endpoints |
| `routes/contexts.js` | Contexts CRUD, member management, plugin runner |
| `routes/perf.js` | Performance metrics API |
| `middleware/auth.js` | Entra ID JWT validation (v1+v2 tokens) |
| `middleware/perfMetrics.js` | Request timing + Server-Timing headers |
