import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as db from '../../db/connection.js';

vi.mock('../../db/connection.js', () => ({ query: vi.fn() }));
const { default: plugin } = await import('./principal-type-tree.js');

const rows = [
  { id: 'mi1', val: 'ManagedIdentity' },
  { id: 'mi2', val: 'ManagedIdentity' },
  { id: 'sp1', val: 'ServicePrincipal' },
  { id: 'u1',  val: 'User' },
];

beforeEach(() => {
  vi.clearAllMocks();
  db.query.mockResolvedValue({ rows });
});

const ctx = { log: () => {} };

describe('principal-type-tree', () => {
  it('groups principals by principalType into a root + one child context per type', async () => {
    const { contexts, members } = await plugin.run({}, ctx);
    const exts = contexts.map((c) => c.externalId);
    expect(exts).toContain('ptype-root');
    expect(exts).toContain('ptype:ManagedIdentity');
    expect(contexts.find((c) => c.externalId === 'ptype:ManagedIdentity').parentExternalId).toBe('ptype-root');
    expect(
      members.filter((m) => m.contextExternalId === 'ptype:ManagedIdentity').map((m) => m.memberId).sort(),
    ).toEqual(['mi1', 'mi2']);
  });

  it('restricts to an allow-list of values when given', async () => {
    const { contexts, members } = await plugin.run({ values: ['ManagedIdentity'] }, ctx);
    const exts = contexts.map((c) => c.externalId);
    expect(exts).toContain('ptype:ManagedIdentity');
    expect(exts).not.toContain('ptype:ServicePrincipal');
    expect(exts).not.toContain('ptype:User');
    expect(members.every((m) => m.contextExternalId === 'ptype:ManagedIdentity')).toBe(true);
  });

  it('rejects an unsafe attribute key', async () => {
    await expect(plugin.run({ attribute: 'bad key!' }, ctx)).rejects.toThrow(/simple key/);
  });
});
