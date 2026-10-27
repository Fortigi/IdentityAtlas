// @vitest-environment jsdom
//
// One hook says whether organisation knowledge is on, so every claim, interview and
// decision on a unit's page hides behind the same flag.
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useOrgKnowledge } from './useOrgKnowledge';

const mockFlags = vi.fn();
vi.mock('@ui/contexts/FeaturesContext', () => ({ useFeatureFlags: () => mockFlags() }));

const on = (flags) => {
  mockFlags.mockReturnValue(flags);
  return renderHook(() => useOrgKnowledge()).result.current;
};

describe('useOrgKnowledge', () => {
  it('is on only when the orgKnowledge flag is exactly true', () => {
    expect(on({ orgKnowledge: true })).toBe(true);
    expect(on({ orgKnowledge: false })).toBe(false);
    expect(on({ orgKnowledge: 'true' })).toBe(false); // a string is not the flag being on
    expect(on({})).toBe(false);                        // not loaded yet: off
  });

  it('is not switched on by another experimental flag', () => {
    expect(on({ contextAssistant: true, customReports: true })).toBe(false);
  });
});
