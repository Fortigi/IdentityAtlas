import { describe, it, expect } from 'vitest';
import { resolveChannel, inferChannelFromVersion, getCurrentVersion } from './channel.js';

describe('channel resolution', () => {
  it('uses IMAGE_TAG when it names a known channel (case-insensitive)', () => {
    expect(resolveChannel({ IMAGE_TAG: 'edge' })).toBe('edge');
    expect(resolveChannel({ IMAGE_TAG: 'BETA' })).toBe('beta');
    expect(resolveChannel({ IMAGE_TAG: 'latest' })).toBe('latest');
  });

  it('marks a fully-pinned image tag as pinned', () => {
    expect(resolveChannel({ IMAGE_TAG: '5.2.1.0' })).toBe('pinned');
  });

  it('infers the channel from the version when IMAGE_TAG is absent', () => {
    expect(resolveChannel({ MODULE_VERSION: '5.3.0-beta.2' })).toBe('beta');
    expect(resolveChannel({ MODULE_VERSION: '5.310.20260629.1221' })).toBe('edge');
    expect(resolveChannel({ MODULE_VERSION: '5.2.1.0' })).toBe('latest');
    // No env + no readable manifest → defaults to latest. Inject a throwing
    // reader so the test never touches the repo's real .psd1.
    const noFile = () => { throw new Error('no manifest'); };
    expect(resolveChannel({}, noFile)).toBe('latest');
  });

  it('inferChannelFromVersion distinguishes edge/beta/release', () => {
    expect(inferChannelFromVersion('5.310.20260629.1221')).toBe('edge'); // 8-digit date segment
    expect(inferChannelFromVersion('5.3.0-beta.1')).toBe('beta');
    expect(inferChannelFromVersion('5.2.0.0')).toBe('latest');
    expect(inferChannelFromVersion(undefined)).toBe('latest');
  });

  it('getCurrentVersion prefers MODULE_VERSION, else null when no manifest', () => {
    expect(getCurrentVersion({ MODULE_VERSION: '5.2.1.0' })).toBe('5.2.1.0');
    expect(getCurrentVersion({}, () => { throw new Error('no manifest'); })).toBe(null);
  });
});
