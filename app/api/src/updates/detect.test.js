import { describe, it, expect, vi } from 'vitest';
import { getLatestForChannel, normalizeTag } from './detect.js';

// A fetch stub that returns a canned response for the first URL substring it matches.
function mockFetch(map) {
  return vi.fn(async (url) => {
    for (const [needle, resp] of Object.entries(map)) {
      if (url.includes(needle)) return resp;
    }
    return { ok: false, status: 404, async text() { return ''; }, async json() { return null; } };
  });
}

describe('detect.getLatestForChannel', () => {
  it('edge → ModuleVersion parsed from the .psd1 on main', async () => {
    const f = mockFetch({
      'IdentityAtlas.psd1': { ok: true, async text() { return "@{\n ModuleVersion = '5.311.20260630.0900'\n}"; } },
    });
    expect(await getLatestForChannel('edge', f)).toBe('5.311.20260630.0900');
  });

  it('latest → newest GitHub release, normalized to image version', async () => {
    const f = mockFetch({ 'releases/latest': { ok: true, async json() { return { tag_name: 'v5.3.0' }; } } });
    expect(await getLatestForChannel('latest', f)).toBe('5.3.0.0');
  });

  it('beta → newest non-draft prerelease', async () => {
    const f = mockFetch({
      'releases?per_page': {
        ok: true,
        async json() {
          return [
            { tag_name: 'v5.3.0-beta.1', prerelease: true, draft: false },
            { tag_name: 'v5.3.0-beta.3', prerelease: true, draft: false },
            { tag_name: 'v5.3.0-beta.4', prerelease: true, draft: true }, // draft ignored
            { tag_name: 'v5.2.0', prerelease: false, draft: false },      // release ignored
          ];
        },
      },
    });
    expect(await getLatestForChannel('beta', f)).toBe('5.3.0-beta.3');
  });

  it('pinned/unknown channel → null (no detection)', async () => {
    expect(await getLatestForChannel('pinned', mockFetch({}))).toBe(null);
  });

  it('throws when the upstream fetch fails', async () => {
    const f = mockFetch({ 'IdentityAtlas.psd1': { ok: false, status: 500 } });
    await expect(getLatestForChannel('edge', f)).rejects.toThrow(/500/);
  });

  it('normalizeTag adds .0 to release tags only', () => {
    expect(normalizeTag('v5.2.1')).toBe('5.2.1.0');
    expect(normalizeTag('5.2.1')).toBe('5.2.1.0');
    expect(normalizeTag('v5.3.0-beta.2')).toBe('5.3.0-beta.2');
    expect(normalizeTag(null)).toBe(null);
  });
});
