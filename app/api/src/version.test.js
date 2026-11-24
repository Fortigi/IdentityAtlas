import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveModuleVersion, parseModuleVersion } from './version.js';

// The real manifest's PSData block, as tools/release/Set-ManifestVersion.ps1 leaves it.
const manifest = (moduleVersion, prereleaseLine) =>
  `@{\n  ModuleVersion = '${moduleVersion}'\n  PrivateData = @{\n    PSData = @{\n      # Prerelease string of this module\n      ${prereleaseLine}\n    }\n  }\n}`;

describe('parseModuleVersion', () => {
  it('joins a pre-release label back onto ModuleVersion, giving the tag version', () => {
    expect(parseModuleVersion(manifest('6.2.0', "Prerelease = 'beta.1'"))).toBe('6.2.0-beta.1');
    expect(parseModuleVersion(manifest('7.0.0', "Prerelease = 'rc.12'"))).toBe('7.0.0-rc.12');
  });

  it('ignores the commented-out Prerelease template line of a release or dev manifest', () => {
    expect(parseModuleVersion(manifest('6.1.2.0', "# Prerelease = ''"))).toBe('6.1.2.0');
    expect(parseModuleVersion(manifest('6.1.2.0', "# Prerelease = 'beta.1'"))).toBe('6.1.2.0');
  });

  it('returns null when there is no ModuleVersion, even with a Prerelease', () => {
    expect(parseModuleVersion("@{\n  Prerelease = 'beta.1'\n}")).toBe(null);
  });

  it('reads the committed setup/IdentityAtlas.psd1 as its plain dev version', () => {
    const text = readFileSync(join(import.meta.dirname, '../../../setup/IdentityAtlas.psd1'), 'utf-8');
    expect(parseModuleVersion(text)).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});

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

describe('resolveModuleVersion on a portable beta', () => {
  it('reports the tag version from a pre-release manifest', () => {
    const read = () => "@{\n  ModuleVersion = '6.2.0'\n  PrivateData = @{ PSData = @{\n    Prerelease = 'beta.1'\n  } }\n}";
    expect(resolveModuleVersion({}, read)).toBe('6.2.0-beta.1');
  });

  it('finds the manifest the portable ZIP ships next to the API bundle', () => {
    const seen = [];
    const read = (p) => {
      seen.push(p);
      if (!p.replace(/\\/g, '/').endsWith('bundled-scripts/setup/IdentityAtlas.psd1')) throw new Error('ENOENT');
      return "ModuleVersion = '6.2.0'\n    Prerelease = 'rc.3'";
    };
    expect(resolveModuleVersion({}, read)).toBe('6.2.0-rc.3');
    expect(seen).toHaveLength(3);
  });
});
