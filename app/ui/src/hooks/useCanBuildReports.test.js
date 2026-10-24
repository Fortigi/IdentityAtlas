// @vitest-environment jsdom
//
// One hook decides who may build reports, so the flag and the permission cannot
// be honoured in one place and forgotten in another. Both are required.
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCanBuildReports } from './useCanBuildReports';

const mockPermission = vi.fn();
const mockFlags = vi.fn();
vi.mock('@ui/auth/usePermissions', () => ({ useHasPermission: (p) => mockPermission(p) }));
vi.mock('@ui/contexts/FeaturesContext', () => ({ useFeatureFlags: () => mockFlags() }));

const canBuild = ({ flag, permission }) => {
  mockFlags.mockReturnValue({ customReports: flag });
  mockPermission.mockReturnValue(permission);
  return renderHook(() => useCanBuildReports()).result.current;
};

describe('useCanBuildReports', () => {
  it('needs the feature on AND the permission', () => {
    expect(canBuild({ flag: true, permission: true })).toBe(true);
    expect(canBuild({ flag: false, permission: true })).toBe(false);
    expect(canBuild({ flag: true, permission: false })).toBe(false);
    expect(canBuild({ flag: false, permission: false })).toBe(false);
  });

  it('asks for the report-writing permission by name', () => {
    canBuild({ flag: true, permission: true });
    expect(mockPermission).toHaveBeenCalledWith('data.write.reports');
  });

  it('treats a missing or not-yet-loaded flag as off', () => {
    mockFlags.mockReturnValue({});
    mockPermission.mockReturnValue(true);
    expect(renderHook(() => useCanBuildReports()).result.current).toBe(false);
    mockFlags.mockReturnValue({ customReports: 'true' }); // a string is not the flag being on
    expect(renderHook(() => useCanBuildReports()).result.current).toBe(false);
  });
});
