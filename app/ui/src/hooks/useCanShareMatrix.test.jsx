// @vitest-environment jsdom
//
// Both conditions are required, and each case flips exactly one of them — a
// hook that checked only the permission, only the flag, or treated a truthy
// non-boolean flag as "on" fails at least one row.
import { describe, it, expect } from 'vitest';
import { useCanShareMatrix } from './useCanShareMatrix';
import { makeWrapper, renderHook } from '@ui/test-utils/renderWithProviders';

const sharer = { permissions: new Set(['data.share']), hasWildcard: false, permissionsLoaded: true };
const reader = { permissions: new Set(['data.read']), hasWildcard: false, permissionsLoaded: true };

function canShare({ auth, features }) {
  const { wrapper } = makeWrapper({ auth, features });
  return renderHook(() => useCanShareMatrix(), { wrapper }).result.current;
}

describe('useCanShareMatrix', () => {
  it.each([
    ['flag on + data.share',          sharer, { matrixSharing: true },   true],
    ['flag off + data.share',         sharer, { matrixSharing: false },  false],
    ['no flags loaded + data.share',  sharer, {},                        false],
    ['flag "true" string + data.share', sharer, { matrixSharing: 'true' }, false],
    ['flag on, no data.share',        reader, { matrixSharing: true },   false],
  ])('%s → %s', (_label, auth, features, expected) => {
    expect(canShare({ auth, features })).toBe(expected);
  });

  it('lets a wildcard admin share once the flag is on, and not before', () => {
    const admin = { permissions: new Set(), hasWildcard: true, permissionsLoaded: true };
    expect(canShare({ auth: admin, features: { matrixSharing: true } })).toBe(true);
    expect(canShare({ auth: admin, features: { matrixSharing: false } })).toBe(false);
  });
});
