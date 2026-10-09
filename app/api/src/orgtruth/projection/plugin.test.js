import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import plugin from './plugin.js';
import { getPlugin, REGISTERED_PLUGINS } from '../../contexts/plugins/registry.js';
import { E, entities, relations, links, memberMap } from './__tests__/projectionFixture.js';

function stage() {
  query
    .mockResolvedValueOnce({ rows: entities })
    .mockResolvedValueOnce({ rows: relations })
    .mockResolvedValueOnce({ rows: links });
}

beforeEach(() => { query.mockReset(); });

describe('org-truth projection plugin (Resource members)', () => {
  it('is registered under a stable name with the plugin contract fields', () => {
    expect(getPlugin('org-truth')).toBe(plugin);
    expect(REGISTERED_PLUGINS.filter(p => p.name === 'org-truth')).toHaveLength(1);
    expect(plugin.targetType).toBe('Resource');
    expect(plugin.displayName).toBe('Organisation truth');
    expect(plugin.parametersSchema.properties.entityTypes.items.type).toBe('string');
    expect(plugin.parametersSchema.required).toBeUndefined();
  });

  it('projects the staged org tables into a tree with resource members, and logs the counts', async () => {
    stage();
    const log = vi.fn();
    const out = await plugin.run({}, { log });
    expect(out.contexts).toHaveLength(9);
    expect(memberMap(out.members)).toEqual({
      [`org:${E.P1}`]: ['G1'],
      [`org:${E.U1}`]: ['G1', 'G7'],
      [`org:${E.T1}`]: ['G7'],
    });
    expect(log).toHaveBeenCalledWith('org-truth: 9 context(s), 4 member link(s).');
  });

  it('honours entityTypes and runs without a ctx', async () => {
    stage();
    const out = await plugin.run({ entityTypes: ['Team'] });
    expect(out.contexts.map(c => c.externalId)).toEqual(['org:root', 'org:type:Team', `org:${E.T1}`]);
    expect(memberMap(out.members)).toEqual({ [`org:${E.T1}`]: ['G7'] });
  });
});
