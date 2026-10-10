import { describe, it, expect } from 'vitest';
import { profileMetadata, LIMITATIONS } from './metadata.js';
import { validateDefinition } from './profileSchema.js';

describe('profileMetadata', () => {
  it('describes each supported combination with its exact metric definition and history method', () => {
    const { definition } = validateDefinition({
      scope: { systemIds: [2] },
      dimensions: [{ field: 'Principal.accountEnabled', label: 'Status' }, { field: 'Principal.ext.tier' }],
      datasets: [
        { id: 'now', metric: 'principals.count', dimensions: ['Principal.accountEnabled', 'Principal.ext.tier'] },
        { id: 'trend', metric: 'principals.countAsOf', dimensions: ['Principal.accountEnabled'], periods: 4 },
      ],
      privacy: { minGroupSize: 10 },
    });
    const meta = profileMetadata({ id: 'p', name: 'W', version: 7, status: 'active', updatedAt: 't', updatedBy: 'ann', definition });

    expect(meta.profile).toEqual({ id: 'p', name: 'W', version: 7, status: 'active', updatedAt: 't', updatedBy: 'ann' });
    expect([meta.scope, meta.privacy, meta.timezone]).toEqual([{ systemIds: [2] }, { minGroupSize: 10 }, 'UTC']);
    expect(meta.datasets.map(d => [d.id, d.metric, d.historyMethod, d.metricVersion, d.periods])).toEqual([
      ['now', 'principals.count', 'current', 1, undefined],
      ['trend', 'principals.countAsOf', 'reconstructed', 1, 4],
    ]);
    expect(meta.datasets[0].dimensions).toEqual([
      { field: 'Principal.accountEnabled', iri: 'https://identityatlas.io/ontology#accountEnabled', label: 'Status', unknownLabel: '(unknown)', entity: 'Principal' },
      { field: 'Principal.ext.tier', iri: null, label: 'tier', unknownLabel: '(unknown)', entity: 'Principal' },
    ]);
    expect(meta.datasets[1].timeGrain).toBe('month');
    expect(meta.limitations).toBe(LIMITATIONS);
    expect(LIMITATIONS.join(' ')).toMatch(/cannot be combined into a joint breakdown/);
  });
});
