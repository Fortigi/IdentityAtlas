import { describe, it, expect } from 'vitest';
import { tabBadge } from './tabBadge';

describe('tabBadge', () => {
  it('maps each known detail-tab type to its badge', () => {
    expect(tabBadge('user')).toBe('U');
    expect(tabBadge('resource')).toBe('R');
    expect(tabBadge('group')).toBe('G');
    expect(tabBadge('department')).toBe('D');
    expect(tabBadge('context')).toBe('C');
    expect(tabBadge('access-package')).toBe('AP');
  });

  it('shows ID (not AP) for identity tabs — #208', () => {
    expect(tabBadge('identity')).toBe('ID');
  });

  it('shows RUN (not AP) for run tabs', () => {
    expect(tabBadge('run')).toBe('RUN');
  });

  it('falls back to AP for an unknown type', () => {
    expect(tabBadge('something-else')).toBe('AP');
  });
});
