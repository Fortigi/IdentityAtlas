import { describe, it, expect } from 'vitest';
import plugin, { _internal } from './ad-ou-from-dn.js';

const { parseOuChain } = _internal;

describe('parseOuChain', () => {
  it('returns [] for empty input', () => {
    expect(parseOuChain('')).toEqual([]);
    expect(parseOuChain(null)).toEqual([]);
  });

  it('returns OU components in innermost-first order', () => {
    expect(parseOuChain('CN=Alice,OU=Finance,OU=HQ,DC=example,DC=com'))
      .toEqual(['Finance', 'HQ']);
  });

  it('ignores CN and DC components', () => {
    expect(parseOuChain('CN=Alice,CN=Users,DC=example,DC=com'))
      .toEqual([]);
  });

  it('handles escaped commas in OU names', () => {
    expect(parseOuChain('CN=Bob,OU=Acme\\, Inc,OU=HQ,DC=example,DC=com'))
      .toEqual(['Acme, Inc', 'HQ']);
  });

  it('trims whitespace around components', () => {
    expect(parseOuChain('CN=Alice, OU = Finance , OU = HQ , DC=example'))
      .toEqual(['Finance', 'HQ']);
  });
});

describe('ad-ou-from-dn plugin metadata', () => {
  it('targets Principal', () => {
    expect(plugin.targetType).toBe('Principal');
  });
  it('requires scopeSystemId', () => {
    expect(plugin.parametersSchema.required).toContain('scopeSystemId');
  });
});
