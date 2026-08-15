import { describe, it, expect } from 'vitest';
import {
  parseParams,
  buildResourceQuery,
  buildCapabilityQuery,
  ensureTypeContext,
  buildTree,
  planesFor,
  addRoleLeaves,
} from './resource-type-tree.js';

describe('resource-type-tree parseParams', () => {
  it('applies defaults for a minimal params object', () => {
    const opts = parseParams({ scopeSystemId: 1 });
    expect(opts).toEqual({
      scopeSystemId: 1,
      attribute: 'azureResourceType',
      rootName: 'Resource Types',
      resourceType: '',
      roleLeaves: false,
    });
  });

  it('parses scopeSystemId as an integer and throws when not finite', () => {
    expect(parseParams({ scopeSystemId: '7' }).scopeSystemId).toBe(7);
    expect(() => parseParams({ scopeSystemId: 'abc' })).toThrow(/scopeSystemId is required/);
    expect(() => parseParams({})).toThrow(/scopeSystemId is required/);
  });

  it('trims and uses a supplied attribute, ignoring a blank or non-string one', () => {
    expect(parseParams({ scopeSystemId: 1, attribute: '  foo  ' }).attribute).toBe('foo');
    expect(parseParams({ scopeSystemId: 1, attribute: '   ' }).attribute).toBe('azureResourceType');
    expect(parseParams({ scopeSystemId: 1, attribute: 42 }).attribute).toBe('azureResourceType');
  });

  it('caps rootName at 500 chars and trims resourceType', () => {
    expect(parseParams({ scopeSystemId: 1, rootName: 'x'.repeat(600) }).rootName).toHaveLength(500);
    expect(parseParams({ scopeSystemId: 1, resourceType: '  AzureResource  ' }).resourceType).toBe('AzureResource');
    expect(parseParams({ scopeSystemId: 1, resourceType: 5 }).resourceType).toBe('');
  });

  it('only treats roleLeaves === true as enabled', () => {
    expect(parseParams({ scopeSystemId: 1, roleLeaves: true }).roleLeaves).toBe(true);
    expect(parseParams({ scopeSystemId: 1, roleLeaves: 'true' }).roleLeaves).toBe(false);
    expect(parseParams({ scopeSystemId: 1, roleLeaves: 1 }).roleLeaves).toBe(false);
  });

  it('rejects an unsafe attribute key', () => {
    expect(() => parseParams({ scopeSystemId: 1, attribute: 'bad key!' })).toThrow(/simple key/);
  });
});

describe('resource-type-tree buildResourceQuery', () => {
  it('binds systemId and attribute, without a resourceType condition by default', () => {
    const { text, params } = buildResourceQuery({ scopeSystemId: 3, attribute: 'azureResourceType', resourceType: '' });
    expect(params).toEqual([3, 'azureResourceType']);
    expect(text).toContain('"systemId" = $1');
    expect(text).toContain('"extendedAttributes" ->> $2 IS NOT NULL');
    expect(text).not.toContain('"resourceType" =');
  });

  it('adds the resourceType condition bound as $3 when supplied', () => {
    const { text, params } = buildResourceQuery({ scopeSystemId: 3, attribute: 'azureResourceType', resourceType: 'AzureResource' });
    expect(params).toEqual([3, 'azureResourceType', 'AzureResource']);
    expect(text).toContain('"resourceType" = $3');
  });
});

describe('resource-type-tree buildCapabilityQuery', () => {
  it('binds systemId and attribute and requires a capability id', () => {
    const { text, params } = buildCapabilityQuery({ scopeSystemId: 9, attribute: 'azureResourceType', resourceType: '' });
    expect(params).toEqual([9, 'azureResourceType']);
    expect(text).toContain('cap."systemId" = $1');
    expect(text).toContain('cap."capabilityId" IS NOT NULL');
    expect(text).not.toContain('sc."resourceType" =');
  });

  it('adds the scope resourceType condition bound as $3 when supplied', () => {
    const { params, text } = buildCapabilityQuery({ scopeSystemId: 9, attribute: 'azureResourceType', resourceType: 'AzureResource' });
    expect(params).toEqual([9, 'azureResourceType', 'AzureResource']);
    expect(text).toContain('sc."resourceType" = $3');
  });
});

describe('resource-type-tree ensureTypeContext', () => {
  it('creates a type context once and reuses it thereafter', () => {
    const seen = new Map();
    const contexts = [];
    const first = ensureTypeContext(seen, contexts, 'VM', 'type-root');
    const second = ensureTypeContext(seen, contexts, 'VM', 'type-root');
    expect(first).toBe('type:VM');
    expect(second).toBe('type:VM');
    expect(contexts).toEqual([
      { externalId: 'type:VM', displayName: 'VM', contextType: 'ResourceType', parentExternalId: 'type-root' },
    ]);
  });
});

describe('resource-type-tree buildTree', () => {
  const rows = [
    { id: 'vm1', val: 'Microsoft.Compute/virtualMachines' },
    { id: 'vm2', val: 'Microsoft.Compute/virtualMachines' },
    { id: 'sa1', val: 'Microsoft.Storage/storageAccounts' },
  ];

  it('creates a root plus one child context per distinct value', () => {
    const { rootExt, contexts, members, seen } = buildTree(rows, 'Resource Types');
    expect(rootExt).toBe('type-root');
    expect(contexts[0]).toMatchObject({ externalId: 'type-root', displayName: 'Resource Types', contextType: 'ResourceTypeRoot' });
    const exts = contexts.map((c) => c.externalId);
    expect(exts).toContain('type:Microsoft.Compute/virtualMachines');
    expect(exts).toContain('type:Microsoft.Storage/storageAccounts');
    expect(seen.size).toBe(2);
    expect(
      members.filter((m) => m.contextExternalId === 'type:Microsoft.Compute/virtualMachines').map((m) => m.memberId),
    ).toEqual(['vm1', 'vm2']);
    expect(members).toContainEqual({ contextExternalId: 'type:Microsoft.Storage/storageAccounts', memberId: 'sa1' });
  });

  it('trims values and skips rows with a blank/null value', () => {
    const { contexts, members, seen } = buildTree(
      [{ id: 'a', val: '  VM  ' }, { id: 'b', val: '' }, { id: 'c', val: null }],
      'Resource Types',
    );
    expect(contexts.map((c) => c.externalId)).toEqual(['type-root', 'type:VM']);
    expect(members).toEqual([{ contextExternalId: 'type:VM', memberId: 'a' }]);
    expect(seen.size).toBe(1);
  });
});

describe('resource-type-tree planesFor', () => {
  it('maps a plane value to its plane group(s)', () => {
    expect(planesFor('data')).toEqual(['data']);
    expect(planesFor('control')).toEqual(['control']);
    expect(planesFor('both')).toEqual(['data', 'control']);
  });

  it('falls back to control only when the plane is falsy (blank/null/undefined)', () => {
    expect(planesFor('')).toEqual(['control']);
    expect(planesFor(null)).toEqual(['control']);
    expect(planesFor(undefined)).toEqual(['control']);
  });

  it('yields no plane group for a truthy but unrecognised plane value', () => {
    expect(planesFor('mystery')).toEqual([]);
  });
});

describe('resource-type-tree addRoleLeaves', () => {
  function freshTree() {
    return { rootExt: 'type-root', contexts: [], members: [], seen: new Map() };
  }

  it('adds plane groups and per-role leaves, tallying new leaves and skipping incomplete rows', () => {
    const tree = freshTree();
    const capRows = [
      { capid: 'c1', role: 'Owner', plane: 'both', typeval: 'Storage' },
      { capid: 'c2', role: 'Owner', plane: 'control', typeval: 'Storage' }, // reuses the control Owner leaf
      { capid: 'c3', role: 'Reader', plane: 'data', typeval: 'Storage' },
      { capid: 'c4', role: '', plane: 'data', typeval: 'Storage' }, // blank role → skipped
      { capid: 'c5', role: 'Reader', plane: 'data', typeval: '' }, // blank type → skipped
    ];
    const { planeCount, leafCount, capCount } = addRoleLeaves(tree, capRows);
    expect(capCount).toBe(5);
    // Storage → data plane + control plane = 2 plane groups.
    expect(planeCount).toBe(2);
    // Owner@data, Owner@control, Reader@data = 3 distinct leaves (c2 reuses Owner@control).
    expect(leafCount).toBe(3);

    const exts = tree.contexts.map((c) => c.externalId);
    expect(exts).toContain('type:Storage');
    expect(exts).toContain('type:Storage|plane:data');
    expect(exts).toContain('type:Storage|plane:control');
    expect(exts).toContain('type:Storage|plane:data|role:Owner');
    expect(exts).toContain('type:Storage|plane:control|role:Owner');
    expect(exts).toContain('type:Storage|plane:data|role:Reader');

    // The plane group gets an "any <plane> access" member for each capability landing in it.
    expect(tree.members).toContainEqual({ contextExternalId: 'type:Storage|plane:control|role:Owner', memberId: 'c1' });
    expect(tree.members).toContainEqual({ contextExternalId: 'type:Storage|plane:control|role:Owner', memberId: 'c2' });
    expect(tree.members).toContainEqual({ contextExternalId: 'type:Storage|plane:data', memberId: 'c3' });
  });

  it('reuses an existing type context created by buildTree', () => {
    const tree = buildTree([{ id: 'r1', val: 'Storage' }], 'Resource Types');
    const beforeTypeContexts = tree.contexts.filter((c) => c.externalId === 'type:Storage').length;
    addRoleLeaves(tree, [{ capid: 'c1', role: 'Owner', plane: 'control', typeval: 'Storage' }]);
    const afterTypeContexts = tree.contexts.filter((c) => c.externalId === 'type:Storage').length;
    expect(beforeTypeContexts).toBe(1);
    expect(afterTypeContexts).toBe(1); // not duplicated
  });
});
