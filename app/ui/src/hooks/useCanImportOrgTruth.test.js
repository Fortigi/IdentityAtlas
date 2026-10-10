// @vitest-environment jsdom
//
// One hook decides who may import organisation truth, so the flag and the permission
// cannot be honoured in one place and forgotten in another. Both are required.
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCanImportOrgTruth } from './useCanImportOrgTruth';

const mockPermission = vi.fn();
const mockFlags = vi.fn();
vi.mock('@ui/auth/usePermissions', () => ({ useHasPermission: (p) => mockPermission(p) }));
vi.mock('@ui/contexts/FeaturesContext', () => ({ useFeatureFlags: () => mockFlags() }));

const canImport = ({ flag, permission }) => {
  mockFlags.mockReturnValue({ orgTruth: flag });
  mockPermission.mockReturnValue(permission);
  return renderHook(() => useCanImportOrgTruth()).result.current;
};

describe('useCanImportOrgTruth', () => {
  it('needs the feature on AND the permission', () => {
    expect(canImport({ flag: true, permission: true })).toBe(true);
    expect(canImport({ flag: false, permission: true })).toBe(false);
    expect(canImport({ flag: true, permission: false })).toBe(false);
    expect(canImport({ flag: false, permission: false })).toBe(false);
  });

  it('asks for the context-writing permission by name', () => {
    canImport({ flag: true, permission: true });
    expect(mockPermission).toHaveBeenCalledWith('data.write.contexts');
  });

  it('treats a missing flag, a string flag, or the context-assistant flag as off', () => {
    mockPermission.mockReturnValue(true);
    for (const flags of [{}, { orgTruth: 'true' }, { contextAssistant: true }]) {
      mockFlags.mockReturnValue(flags);
      expect(renderHook(() => useCanImportOrgTruth()).result.current).toBe(false);
    }
  });
});
