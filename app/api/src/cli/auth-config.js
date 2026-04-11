#!/usr/bin/env node
//
// Auth configuration CLI — the only way to change Identity Atlas authentication
// settings. There is no UI form because that would require an unauthenticated
// mutation surface (the operator can't sign in to change auth settings if
// they're not signed in yet, but exposing PUT without auth is a security hole).
//
// This script runs inside the web container and writes directly to WorkerConfig.
// It's intended to be invoked via:
//
//   docker compose exec web node /app/backend/src/cli/auth-config.js <command>
//
// Commands:
//   status                                    — print current settings
//   enable --tenant <guid> --client <guid>    — turn auth on
//          [--roles role1,role2]                with the given Entra app
//   disable                                   — turn auth off (recovery!)
//
// After any change, restart the web container so the new config is picked up:
//   docker compose restart web
//
// Security model:
//   - The disable path is the recovery mechanism: if you lock yourself out
//     (wrong tenant, wrong roles) you can always disable auth via the CLI
//     because it runs inside the container (requires docker exec = host access).
//   - The recovery path (locked out → flip auth off) requires shell access
//     to the Docker host — the same trust boundary as the database itself.

import pg from 'pg';
import { fileURLToPath } from 'url';

const useSql = process.env.USE_SQL === 'true';
if (!useSql) {
  console.error('USE_SQL is not "true" — this CLI requires database access.');
  process.exit(2);
}

function buildPgConfig() {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL };
  }
  return {
    host:     process.env.POSTGRES_HOST     || 'postgres',
    port:     parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB       || 'identity_atlas',
    user:     process.env.POSTGRES_USER     || 'identity_atlas',
    password: process.env.POSTGRES_PASSWORD || '',
  };
}

const GUID_RE = /^[0-9a-f-]{36}$/i;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function withClient(fn) {
  const client = new pg.Client(buildPgConfig());
  await client.connect();
  try { return await fn(client); }
  finally { await client.end(); }
}

async function readSettings(client) {
  const r = await client.query(
    `SELECT "configKey", "configValue" FROM "WorkerConfig"
     WHERE "configKey" IN ('AUTH_ENABLED','AUTH_TENANT_ID','AUTH_CLIENT_ID','AUTH_REQUIRED_ROLES')`
  );
  const map = {};
  for (const row of r.rows) map[row.configKey] = row.configValue;
  return {
    enabled:       (map.AUTH_ENABLED || 'false').toLowerCase() === 'true',
    tenantId:      map.AUTH_TENANT_ID || '',
    clientId:      map.AUTH_CLIENT_ID || '',
    requiredRoles: (map.AUTH_REQUIRED_ROLES || '').split(',').map(s => s.trim()).filter(Boolean),
  };
}

async function upsert(client, key, value) {
  await client.query(
    `INSERT INTO "WorkerConfig" ("configKey", "configValue")
     VALUES ($1, $2)
     ON CONFLICT ("configKey") DO UPDATE
       SET "configValue" = EXCLUDED."configValue",
           "updatedAt"   = now() AT TIME ZONE 'utc'`,
    [key, value]
  );
}

function printStatus(s) {
  console.log('');
  console.log('  Identity Atlas — Authentication Settings');
  console.log('  ────────────────────────────────────────');
  console.log(`  Status:         ${s.enabled ? '\x1b[32mENABLED\x1b[0m' : '\x1b[33mDISABLED\x1b[0m'}`);
  console.log(`  Tenant ID:      ${s.tenantId || '(not set)'}`);
  console.log(`  Client ID:      ${s.clientId || '(not set)'}`);
  console.log(`  Required roles: ${s.requiredRoles.length ? s.requiredRoles.join(', ') : '(none — any signed-in user)'}`);
  console.log('');
}

function usage() {
  console.log(`
Identity Atlas — Auth Config CLI

Usage:
  node /app/backend/src/cli/auth-config.js <command> [options]

Commands:
  status                                       Show current auth settings
  enable --tenant <guid> --client <guid>       Enable Entra ID SSO
         [--roles role1,role2]
  disable                                      Disable auth (recovery path)

Examples:
  # From your host machine
  docker compose exec web node /app/backend/src/cli/auth-config.js status

  docker compose exec web node /app/backend/src/cli/auth-config.js \\
      enable --tenant 10b6a2c8-41f9-400d-8020-4ca96606899f \\
             --client 368b9b10-24cf-446f-b5f2-a0a2dbe83a65

  docker compose exec web node /app/backend/src/cli/auth-config.js disable

After any change, restart the web container so the API picks up the new config:
  docker compose restart web
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }

  if (cmd === 'status') {
    await withClient(async (client) => {
      const s = await readSettings(client);
      printStatus(s);
    });
    return;
  }

  if (cmd === 'enable') {
    const tenant = args.tenant;
    const client_id = args.client;
    const roles  = args.roles ? String(args.roles) : '';

    if (!tenant || !GUID_RE.test(tenant)) {
      console.error('Error: --tenant <guid> is required and must be a valid GUID');
      process.exit(1);
    }
    if (!client_id || !GUID_RE.test(client_id)) {
      console.error('Error: --client <guid> is required and must be a valid GUID');
      process.exit(1);
    }

    await withClient(async (client) => {
      await upsert(client, 'AUTH_TENANT_ID', tenant);
      await upsert(client, 'AUTH_CLIENT_ID', client_id);
      await upsert(client, 'AUTH_REQUIRED_ROLES', roles);
      await upsert(client, 'AUTH_ENABLED', 'true');
      const s = await readSettings(client);
      printStatus(s);
    });
    console.log('  Auth enabled in DB. Run \x1b[36mdocker compose restart web\x1b[0m to activate.\n');
    return;
  }

  if (cmd === 'disable') {
    await withClient(async (client) => {
      await upsert(client, 'AUTH_ENABLED', 'false');
      const s = await readSettings(client);
      printStatus(s);
    });
    console.log('  Auth disabled in DB. Run \x1b[36mdocker compose restart web\x1b[0m to activate.\n');
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  usage();
  process.exit(1);
}

// Only run main when invoked directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
