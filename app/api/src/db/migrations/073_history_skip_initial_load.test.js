import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '073_history_skip_initial_load.sql'), 'utf8');
const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');

// Text-level guard. The behaviour — the engine's initial load writing no insert
// history, deletes and later inserts still recorded — is proven against real
// PostgreSQL in contract-tests/historyInitialLoad.contract.test.js.
describe('migration 073 — no insert history for an initial load', () => {
  const TRACKED = ['Principals', 'Resources', 'ResourceAssignments', 'ResourceRelationships',
    'AssignmentPolicies', 'GovernanceCatalogs', 'Systems', 'IdentityMembers'];

  it('covers every table migration 022 tracks', () => {
    for (const t of TRACKED) expect(code, t).toContain(`'${t}'`);
  });

  it('drops the combined insert/delete trigger and creates the split pair', () => {
    expect(code).toContain('DROP TRIGGER IF EXISTS trg_history_ins_del ON %I');
    expect(code).toMatch(/CREATE TRIGGER trg_history_ins\s+AFTER INSERT ON %I/);
    expect(code).toMatch(/CREATE TRIGGER trg_history_del\s+AFTER DELETE ON %I\s+FOR EACH ROW\s+EXECUTE FUNCTION fg_record_history\(\)/);
  });

  it('skips only inserts, and only while the transaction-local flag is on', () => {
    expect(code).toMatch(/AFTER INSERT ON %I\s+FOR EACH ROW\s+WHEN \(current_setting\('identity_atlas\.initial_load', true\) IS DISTINCT FROM 'on'\)/);
    // the delete trigger carries no condition
    expect(code).not.toMatch(/AFTER DELETE ON %I\s+FOR EACH ROW\s+WHEN/);
  });

  it('leaves the UPDATE trigger alone', () => {
    expect(code).not.toContain('trg_history_upd');
  });
});
