import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import plugin from './pluginPrincipals.js';
import resourcePlugin from './plugin.js';
import { getPlugin } from '../../contexts/plugins/registry.js';
import { E, entities, relations, links, memberMap } from './__tests__/projectionFixture.js';

beforeEach(() => { query.mockReset(); });

describe('org-truth-principals projection plugin (Principal members)', () => {
  it('is registered next to the Resource plugin with Principal members', () => {
    expect(getPlugin('org-truth-principals')).toBe(plugin);
    expect(plugin.targetType).toBe('Principal');
    expect(plugin.name).not.toBe(resourcePlugin.name);
    expect(plugin.parametersSchema).toEqual(resourcePlugin.parametersSchema);
  });

  it("puts a project's owner's accounts (direct and via the identity) in the project context", async () => {
    query
      .mockResolvedValueOnce({ rows: entities })
      .mockResolvedValueOnce({ rows: relations })
      .mockResolvedValueOnce({ rows: links });
    const log = vi.fn();
    const out = await plugin.run({ entityTypes: ['Project'] }, { log });
    expect(out.contexts.map(c => c.externalId)).toEqual(['org:root', 'org:type:Project', `org:${E.P1}`, `org:${E.P2}`]);
    expect(memberMap(out.members)).toEqual({ [`org:${E.P1}`]: ['A1', 'A2', 'A3'] });
    expect(log).toHaveBeenCalledWith('org-truth-principals: 4 context(s), 3 member link(s).');
  });
});
