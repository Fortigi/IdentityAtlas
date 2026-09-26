/**
 * Tests for the sql crawler.json configSchema — the connection fields, the
 * credential pair, and the queries[] slot shape — exercised through the
 * manifest-driven validateCrawlerConfig() engine. Runs under the API's vitest.
 */
import { describe, it, expect } from 'vitest';
import { validateCrawlerConfig } from '@api/crawlerManifests.js';

const v = (config) => validateCrawlerConfig('sql', config);

const identities = { name: 'Identities', target: 'identities', sql: 'SELECT id, display_name AS displayName FROM spt_identity' };
const minimal = { server: 'sql01', database: 'identityiq', username: 'u', password: 'p', queries: [identities] };

describe('validateCrawlerConfig (sql)', () => {
  it('accepts a minimal valid config', () => {
    expect(v(minimal)).toBeNull();
  });

  it('accepts the full wizard payload', () => {
    expect(v({
      ...minimal, port: 1433, encrypt: true, trustServerCertificate: false,
      connectTimeoutSeconds: 30, commandTimeoutSeconds: 0, batchSize: 5000, pageSize: 10000, systemName: 'IdentityIQ',
      schedules: [{ enabled: true, syncMode: 'full', frequency: 'daily', hour: 2, minute: 0 }],
      queries: [
        identities,
        { name: 'Entitlements', target: 'resources', sql: 'SELECT 1', resourceType: 'Entitlement', enabled: true },
        { name: 'Role assignments', target: 'assignments', sql: 'SELECT 1', resourceType: 'BusinessRole', assignmentType: 'Direct', governed: true },
        { name: 'Role hierarchy', target: 'relationships', sql: 'SELECT 1', relationshipType: 'Contains' },
        { name: 'Accounts', target: 'principals', sql: 'SELECT 1', principalType: 'ServicePrincipal', enabled: false },
        { name: 'Links', target: 'identity-members', sql: 'SELECT 1' },
      ],
    })).toBeNull();
  });

  it('errors when server is missing or blank', () => {
    const { server: _s, ...rest } = minimal;
    expect(v(rest)).toMatch(/server/);
    expect(v({ ...minimal, server: '' })).toMatch(/server/);
  });

  it('errors when database is missing', () => {
    const { database: _d, ...rest } = minimal;
    expect(v(rest)).toMatch(/database/);
  });

  it('errors when username or password is missing', () => {
    const { username: _u, ...noUser } = minimal;
    expect(v(noUser)).toMatch(/username/);
    const { password: _p, ...noPassword } = minimal;
    expect(v(noPassword)).toMatch(/password/);
  });

  it('errors when queries is missing or empty', () => {
    const { queries: _q, ...rest } = minimal;
    expect(v(rest)).toMatch(/queries/);
    expect(v({ ...minimal, queries: [] })).toMatch(/queries/);
  });

  it('errors on a slot with an unknown target', () => {
    expect(v({ ...minimal, queries: [{ ...identities, target: 'groups' }] })).toMatch(/target/);
  });

  it('errors on a slot without name, target or sql', () => {
    expect(v({ ...minimal, queries: [{ target: 'identities', sql: 'SELECT 1' }] })).toMatch(/name/);
    expect(v({ ...minimal, queries: [{ name: 'X', sql: 'SELECT 1' }] })).toMatch(/target/);
    expect(v({ ...minimal, queries: [{ name: 'X', target: 'identities', sql: '' }] })).toMatch(/sql/);
  });

  it('errors on an out-of-range or non-integer port', () => {
    expect(v({ ...minimal, port: 70000 })).toMatch(/port/);
    expect(v({ ...minimal, port: 0 })).toMatch(/port/);
    expect(v({ ...minimal, port: '1433' })).toMatch(/port/);
  });

  it('errors on an unknown assignmentType, relationshipType or principalType', () => {
    expect(v({ ...minimal, queries: [{ ...identities, target: 'assignments', resourceType: 'E', assignmentType: 'Owner' }] })).toMatch(/assignmentType/);
    expect(v({ ...minimal, queries: [{ ...identities, target: 'relationships', relationshipType: 'MemberOf' }] })).toMatch(/relationshipType/);
    expect(v({ ...minimal, queries: [{ ...identities, principalType: 'Robot' }] })).toMatch(/principalType/);
  });

  it('errors on a batch size below the floor', () => {
    expect(v({ ...minimal, batchSize: 10 })).toMatch(/batchSize/);
  });
});

/**
 * A slot may carry a columnMap — source column name → contract column name —
 * for SQL the operator cannot alias. The schema is what stops a wizard (or a
 * hand-edited config) storing a shape the crawler cannot read.
 */
describe('validateCrawlerConfig (sql) — columnMap', () => {
  const withMap = columnMap => v({ ...minimal, queries: [{ ...identities, columnMap }] });

  it('accepts a slot that maps its source columns onto the contract', () => {
    expect(withMap({ IdentityID: 'id', DisplayNameField: 'displayName' })).toBeNull();
    expect(withMap({})).toBeNull();
    expect(v(minimal)).toBeNull();
  });

  it('errors when a mapped value is not a column name', () => {
    expect(withMap({ EntitlementID: 1 })).toMatch(/columnMap/);
    expect(withMap({ EntitlementID: null })).toMatch(/columnMap/);
    expect(withMap({ EntitlementID: ['id'] })).toMatch(/columnMap/);
    expect(withMap({ Good: 'id', Bad: false })).toMatch(/columnMap/);
  });

  it('errors when the mapping itself is not an object', () => {
    expect(withMap([{ from: 'EntitlementID', to: 'id' }])).toMatch(/columnMap/);
    expect(withMap('EntitlementID=id')).toMatch(/columnMap/);
  });
});
