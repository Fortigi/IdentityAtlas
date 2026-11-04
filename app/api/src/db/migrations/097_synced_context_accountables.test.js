// Static checks on migration 096. What it selects is verified against PostgreSQL
// in contract-tests/contextOwnerRoles.contract.test.js; these pin the shape that
// keeps it safe to run on a live database: insert-only, synced only, the same
// resolution as the ingest, and nothing that writes Contexts (migration 094's
// deferred-trigger trap).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { OWNER_PRINCIPAL_ORDER, ownerResolutionCtes } from '../../ingest/contextOwners.js';
import { ROLE_BEARING_CATEGORIES } from '../../lib/contextCategories.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '096_synced_context_accountables.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');
const squash = (s) => s.replace(/\s+/g, ' ').trim();

describe('migration 096 — synced owners become Accountables', () => {
  it('only inserts: no UPDATE, DELETE or DDL anywhere', () => {
    expect(statements).not.toMatch(/\b(UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i);
    expect(statements.match(/INSERT INTO "(\w+)"/g)).toEqual(['INSERT INTO "ContextRoles"']);
    expect(statements).toMatch(/ON CONFLICT DO NOTHING;\s*$/);
  });

  it('never writes Contexts, so the deferred cycle check has nothing queued', () => {
    expect(statements).not.toMatch(/(INSERT INTO|UPDATE)\s+"Contexts"/);
  });

  it('considers synced contexts on a role-bearing template that have an owner and no Accountable yet', () => {
    expect(statements).toMatch(/WHERE c\.variant = 'synced'/);
    const cats = statements.match(/"contextCategory" IN \(([^)]+)\)/)[1].split(',').map(s => s.trim().replace(/'/g, ''));
    expect(cats.sort()).toEqual([...ROLE_BEARING_CATEGORIES].sort());
    expect(statements).toMatch(/NULLIF\(c\."ownerUserId", ''\) IS NOT NULL/);
    expect(statements).toMatch(/NOT EXISTS \(SELECT 1 FROM "ContextRoles" r WHERE r\."contextId" = c\.id AND r\.role = 'Accountable'\)/);
  });

  it('writes the role as an Accountable added by sync', () => {
    for (const sel of statements.match(/SELECT "contextId", "principalId", '(\w+)', '(\w+)'/g)) {
      expect(sel).toBe(`SELECT "contextId", "principalId", 'Accountable', 'sync'`);
    }
  });

  it('resolves exactly as the ingest does', () => {
    expect(squash(statements)).toContain(squash(`ORDER BY c.id, ${OWNER_PRINCIPAL_ORDER}`));
    // The two resolution CTEs are the ingest's, word for word.
    const ingest = squash(ownerResolutionCtes('TRUE'));
    // A CTE's body runs from "<name> AS (" to its closing ") ," / ") INSERT".
    const body = (text, cte) => {
      const s = squash(text);
      const from = s.indexOf(`${cte} AS (`);
      const ends = [s.indexOf(') ,', from), s.indexOf('),', from), s.indexOf(') INSERT', from)].filter(i => i > from);
      return s.slice(from, Math.min(...ends)).trim();
    };
    expect(body(statements, 'by_external_id')).toMatch(/^by_external_id AS \( SELECT DISTINCT ON \(c\.id\).*p\.id$/);
    expect(body(statements, 'by_employee_id')).toMatch(/^by_employee_id AS \( SELECT .*HAVING count\(\*\) = 1$/);
    for (const cte of ['by_external_id', 'by_employee_id']) {
      expect(body(statements, cte)).toBe(body(ingest, cte));
    }
  });
});
