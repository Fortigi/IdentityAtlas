import { describe, it, expect } from 'vitest';
import { parseParams, buildTree } from './principal-type-tree.js';

describe('principal-type-tree parseParams', () => {
  it('applies defaults for empty params', () => {
    const { attribute, rootName, systemId, allow } = parseParams({});
    expect(attribute).toBe('principalType');
    expect(rootName).toBe('Principal Types');
    expect(systemId).toBeNull();
    expect(allow.size).toBe(0);
  });

  it('trims and uses a supplied attribute, ignoring a blank one', () => {
    expect(parseParams({ attribute: '  foo  ' }).attribute).toBe('foo');
    expect(parseParams({ attribute: '   ' }).attribute).toBe('principalType');
    expect(parseParams({ attribute: 42 }).attribute).toBe('principalType');
  });

  it('caps rootName at 500 chars', () => {
    expect(parseParams({ rootName: 'x'.repeat(600) }).rootName).toHaveLength(500);
  });

  it('parses systemId as an integer, null when not finite', () => {
    expect(parseParams({ systemId: '7' }).systemId).toBe(7);
    expect(parseParams({ systemId: 'abc' }).systemId).toBeNull();
    expect(parseParams({ systemId: undefined }).systemId).toBeNull();
  });

  it('builds the allow-set from string values, trimming and dropping blanks/non-strings', () => {
    const { allow } = parseParams({ values: [' ManagedIdentity ', 'AIAgent', '', '  ', 5, null] });
    expect([...allow].sort()).toEqual(['AIAgent', 'ManagedIdentity']);
  });

  it('ignores a non-array values param', () => {
    expect(parseParams({ values: 'ManagedIdentity' }).allow.size).toBe(0);
  });
});

describe('principal-type-tree buildTree', () => {
  const rows = [
    { id: 'mi1', val: 'ManagedIdentity' },
    { id: 'mi2', val: 'ManagedIdentity' },
    { id: 'sp1', val: 'ServicePrincipal' },
    { id: 'u1', val: 'User' },
  ];

  it('creates a root plus one child context per distinct value', () => {
    const { contexts, members, typeCount } = buildTree(rows, 'Principal Types', new Set());
    const exts = contexts.map((c) => c.externalId);
    expect(exts[0]).toBe('ptype-root');
    expect(contexts[0]).toMatchObject({ displayName: 'Principal Types', contextType: 'PrincipalTypeRoot' });
    expect(exts).toContain('ptype:ManagedIdentity');
    expect(exts).toContain('ptype:ServicePrincipal');
    expect(exts).toContain('ptype:User');
    expect(typeCount).toBe(3);
    expect(contexts.find((c) => c.externalId === 'ptype:ManagedIdentity')).toMatchObject({
      displayName: 'ManagedIdentity',
      contextType: 'PrincipalType',
      parentExternalId: 'ptype-root',
    });
    expect(members.filter((m) => m.contextExternalId === 'ptype:ManagedIdentity').map((m) => m.memberId)).toEqual(['mi1', 'mi2']);
    expect(members).toHaveLength(4);
  });

  it('restricts to the allow-set when non-empty', () => {
    const { contexts, members, typeCount } = buildTree(rows, 'Principal Types', new Set(['ManagedIdentity']));
    const exts = contexts.map((c) => c.externalId);
    expect(exts).toContain('ptype:ManagedIdentity');
    expect(exts).not.toContain('ptype:ServicePrincipal');
    expect(exts).not.toContain('ptype:User');
    expect(typeCount).toBe(1);
    expect(members.every((m) => m.contextExternalId === 'ptype:ManagedIdentity')).toBe(true);
  });

  it('trims values and skips rows with a blank value', () => {
    const { contexts, members, typeCount } = buildTree(
      [{ id: 'a', val: '  ManagedIdentity  ' }, { id: 'b', val: '' }, { id: 'c', val: null }],
      'Principal Types',
      new Set(),
    );
    expect(contexts.map((c) => c.externalId)).toEqual(['ptype-root', 'ptype:ManagedIdentity']);
    expect(members).toEqual([{ contextExternalId: 'ptype:ManagedIdentity', memberId: 'a' }]);
    expect(typeCount).toBe(1);
  });
});
