import { describe, it, expect } from 'vitest';
import { parseVersion, compareVersions, isNewer } from './versionCompare.js';

describe('versionCompare', () => {
  it('orders release versions numerically (not lexically)', () => {
    expect(compareVersions('5.2.1.0', '5.2.0.0')).toBe(1);
    expect(compareVersions('5.2.0.0', '5.2.1.0')).toBe(-1);
    expect(compareVersions('5.2.1.0', '5.2.1.0')).toBe(0);
    expect(compareVersions('5.10.0.0', '5.9.0.0')).toBe(1); // 10 > 9, not "10" < "9"
  });

  it('orders edge timestamp builds', () => {
    expect(isNewer('5.310.20260630.0900', '5.310.20260629.1221')).toBe(true);
    expect(isNewer('5.310.20260629.1221', '5.310.20260630.0900')).toBe(false);
  });

  it('ranks a final release above a prerelease of the same core, and orders betas', () => {
    expect(compareVersions('5.3.0.0', '5.3.0-beta.2')).toBe(1);
    expect(compareVersions('5.3.0-beta.2', '5.3.0.0')).toBe(-1);
    expect(compareVersions('5.3.0-beta.3', '5.3.0-beta.2')).toBe(1);
    expect(isNewer('5.3.0-beta.2', '5.3.0-beta.2')).toBe(false);
  });

  it('treats unparseable input as equal so it never reports a false "newer"', () => {
    expect(compareVersions('garbage', '5.2.0.0')).toBe(0);
    expect(isNewer(null, '5.2.0.0')).toBe(false);
    expect(isNewer('5.2.0.0', undefined)).toBe(false);
  });

  it('parseVersion strips a leading v and splits segments', () => {
    expect(parseVersion('v5.2.1').nums).toEqual([5, 2, 1]);
    expect(parseVersion('5.3.0-beta.4').preNum).toBe(4);
    expect(parseVersion('')).toBe(null);
    expect(parseVersion(42)).toBe(null);
  });
});
