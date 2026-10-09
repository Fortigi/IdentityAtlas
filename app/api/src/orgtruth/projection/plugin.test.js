import { describe, it, expect, vi } from 'vitest';
import plugin from './plugin.js';
import { getPlugin, REGISTERED_PLUGINS } from '../../contexts/plugins/registry.js';

describe('org-truth projection plugin', () => {
  it('is registered under a stable name with the plugin contract fields', () => {
    expect(getPlugin('org-truth')).toBe(plugin);
    expect(REGISTERED_PLUGINS.filter(p => p.name === 'org-truth')).toHaveLength(1);
    expect(plugin.targetType).toBe('Resource');
    expect(plugin.parametersSchema.properties.entityTypes.items.type).toBe('string');
  });

  it('emits nothing yet and logs why (stub for workstream T4)', async () => {
    const log = vi.fn();
    expect(await plugin.run({}, { log })).toEqual({ contexts: [], members: [] });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not built yet'));
    expect(await plugin.run({}, {})).toEqual({ contexts: [], members: [] });
  });
});
