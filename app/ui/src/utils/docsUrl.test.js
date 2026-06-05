import { describe, it, expect } from 'vitest';
import { docsUrl, docsVersionAlias } from './docsUrl';

describe('docsUrl', () => {
  it('maps an edge/dev build (date-based version) to the edge docs', () => {
    expect(docsVersionAlias('5.131.20260605.1037')).toBe('edge');
    expect(docsUrl('5.131.20260605.1037', '/concepts/data-model/'))
      .toBe('https://fortigi.github.io/IdentityAtlas/edge/concepts/data-model/');
  });

  it('maps a release build (patch-based version) to the stable docs', () => {
    expect(docsVersionAlias('5.2.1.0')).toBe('stable');
    expect(docsUrl('5.2.1.0')).toBe('https://fortigi.github.io/IdentityAtlas/stable');
  });

  it('defaults to stable for unknown/blank versions', () => {
    expect(docsVersionAlias(null)).toBe('stable');
    expect(docsVersionAlias('')).toBe('stable');
  });
});
