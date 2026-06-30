import { describe, it, expect } from 'vitest';
import { resolveModuleVersion } from './version.js';

describe('resolveModuleVersion', () => {
  it('prefers the MODULE_VERSION env var (no file read)', () => {
    const read = () => { throw new Error('should not read the file'); };
    expect(resolveModuleVersion({ MODULE_VERSION: '5.2.1.0' }, read)).toBe('5.2.1.0');
  });

  it('falls back to the .psd1 ModuleVersion when the env var is absent', () => {
    const read = () => "@{\n  ModuleVersion = '5.324.20260630.0743'\n}";
    expect(resolveModuleVersion({}, read)).toBe('5.324.20260630.0743');
  });

  it('tries the next candidate path when the first read throws', () => {
    let calls = 0;
    const read = () => {
      calls += 1;
      if (calls === 1) throw new Error('ENOENT');
      return "ModuleVersion = '5.7.2.0'";
    };
    expect(resolveModuleVersion({}, read)).toBe('5.7.2.0');
    expect(calls).toBe(2);
  });

  it('returns null when neither the env var nor any file yields a version', () => {
    expect(resolveModuleVersion({}, () => { throw new Error('nope'); })).toBe(null);
    expect(resolveModuleVersion({}, () => 'no version field here')).toBe(null);
  });
});
