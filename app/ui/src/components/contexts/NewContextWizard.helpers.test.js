import { describe, it, expect } from 'vitest';
import {
  stepsFor, groupByTargetType, prettifyName, wizardSubtitle,
  seedParamsFromSchema, pluginMissingParams, computeRefreshTargets,
  runLabel, runDisabled, nextLabel,
} from './NewContextWizard.helpers';

describe('stepsFor', () => {
  it('returns the four-step plugin flow', () => {
    expect(stepsFor('plugin').map(s => s.label)).toEqual(['Source', 'Pick plugin', 'Configure', 'Preview & run']);
  });
  it('returns the two-step manual flow', () => {
    expect(stepsFor('manual').map(s => s.label)).toEqual(['Source', 'Details']);
  });
  it('returns just the source step for anything else', () => {
    expect(stepsFor(null).map(s => s.label)).toEqual(['Source']);
    expect(stepsFor('import').map(s => s.label)).toEqual(['Source']);
  });
});

describe('groupByTargetType', () => {
  it('buckets plugins by targetType, sorted alphabetically', () => {
    const plugins = [
      { name: 'a', targetType: 'Resource' },
      { name: 'b', targetType: 'Identity' },
      { name: 'c', targetType: 'Identity' },
    ];
    const grouped = groupByTargetType(plugins);
    expect(grouped.map(([t]) => t)).toEqual(['Identity', 'Resource']);
    expect(grouped[0][1].map(p => p.name)).toEqual(['b', 'c']);
    expect(grouped[1][1].map(p => p.name)).toEqual(['a']);
  });
  it('returns [] for no plugins', () => {
    expect(groupByTargetType([])).toEqual([]);
  });
});

describe('prettifyName', () => {
  it('splits camelCase and capitalises', () => {
    expect(prettifyName('scopeSystemId')).toBe('Scope System Id');
    expect(prettifyName('rootName')).toBe('Root Name');
  });
});

describe('wizardSubtitle', () => {
  it('prompts for a source when none chosen', () => {
    expect(wizardSubtitle(null, null)).toMatch(/Where should this tree/);
  });
  it('shows the plugin name once selected, else a prompt', () => {
    expect(wizardSubtitle('plugin', { displayName: 'Manager Hierarchy' })).toBe('Manager Hierarchy');
    expect(wizardSubtitle('plugin', null)).toMatch(/Build a tree/);
  });
  it('describes manual and import sources', () => {
    expect(wizardSubtitle('manual', null)).toMatch(/empty tree/);
    expect(wizardSubtitle('import', null)).toMatch(/Import from a crawler/);
  });
});

describe('seedParamsFromSchema', () => {
  it('picks up only properties that declare a default', () => {
    const selected = {
      parametersSchema: {
        properties: {
          rootName: { type: 'string', default: 'Org Chart' },
          depth: { type: 'integer', default: 3 },
          scopeSystemId: { type: 'integer' },
        },
      },
    };
    expect(seedParamsFromSchema(selected)).toEqual({ rootName: 'Org Chart', depth: 3 });
  });
  it('returns {} for a plugin with no properties or no selection', () => {
    expect(seedParamsFromSchema(null)).toEqual({});
    expect(seedParamsFromSchema({ parametersSchema: {} })).toEqual({});
  });
});

describe('pluginMissingParams', () => {
  it('returns [] when nothing is selected', () => {
    expect(pluginMissingParams(null, {})).toEqual([]);
  });
  it('lists required params that are empty / null / undefined', () => {
    const selected = { parametersSchema: { required: ['a', 'b', 'c', 'd'] } };
    expect(pluginMissingParams(selected, { a: 'set', b: '', c: null })).toEqual(['b', 'c', 'd']);
  });
  it('returns [] when all required params are filled', () => {
    const selected = { parametersSchema: { required: ['a'] } };
    expect(pluginMissingParams(selected, { a: 'x' })).toEqual([]);
  });
});

describe('computeRefreshTargets', () => {
  const roots = [
    { id: 1, sourceAlgorithmName: 'algo', sourceInstanceKey: 'k1', scopeSystemId: 5 },
    { id: 2, sourceAlgorithmName: 'algo', sourceInstanceKey: null, scopeSystemId: 5 },
    { id: 3, sourceAlgorithmName: 'other', sourceInstanceKey: 'k3', scopeSystemId: 5 },
    { id: 4, sourceAlgorithmName: 'algo', sourceInstanceKey: 'k4', scopeSystemId: 9 },
  ];
  const selected = { name: 'algo' };

  it('returns [] with no selection', () => {
    expect(computeRefreshTargets(roots, null, '')).toEqual([]);
  });
  it('matches algorithm and requires an instance key when system is unscoped', () => {
    expect(computeRefreshTargets(roots, selected, '').map(r => r.id)).toEqual([1, 4]);
  });
  it('further narrows by the chosen scope system', () => {
    expect(computeRefreshTargets(roots, selected, '5').map(r => r.id)).toEqual([1]);
  });
});

describe('footer labels / gates', () => {
  it('runLabel reflects running / refresh / new', () => {
    expect(runLabel(true, 'new')).toBe('Starting…');
    expect(runLabel(false, 'refresh')).toBe('Refresh tree');
    expect(runLabel(false, 'new')).toBe('Create tree');
  });
  it('runDisabled blocks while busy or when a refresh lacks a key', () => {
    expect(runDisabled(true, false, 'new', '')).toBe(true);
    expect(runDisabled(false, true, 'new', '')).toBe(true);
    expect(runDisabled(false, false, 'refresh', '')).toBe(true);
    expect(runDisabled(false, false, 'refresh', 'k')).toBe(false);
    expect(runDisabled(false, false, 'new', '')).toBe(false);
  });
  it('nextLabel switches to the crawlers CTA only on the import source step', () => {
    expect(nextLabel(1, 'import')).toBe('Open Crawlers →');
    expect(nextLabel(1, 'plugin')).toBe('Next ▸');
    expect(nextLabel(2, 'import')).toBe('Next ▸');
  });
});
