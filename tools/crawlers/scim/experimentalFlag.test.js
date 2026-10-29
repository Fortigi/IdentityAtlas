// SCIM graduated from EXPERIMENTAL to a regular crawler. Experimental status is
// declared in TWO places, read by two different layers:
//
//   crawler.json      "experimental"  → the server-side gate
//                     (crawlerManifests.isExperimentalType → a 403 from
//                     POST /api/admin/crawler-configs)
//   CrawlerMeta.js    experimental    → the Add-Crawler picker filter
//                     and the Experimental badge
//
// Leaving either one behind half-graduates the crawler: refused by the API but
// offered in the picker, or creatable but still badged as unproven. This pins
// that both halves are gone, and that they agree.
//
// Lives here, not in app/ui/ or app/api/src/, because it is specific to one
// crawler type — see tools/crawlers/CLAUDE.md and the crawler-manifest CI gate.
import { describe, it, expect } from 'vitest';
import manifest from './crawler.json';
import meta from './CrawlerMeta.js';

describe('SCIM is a regular (non-experimental) crawler', () => {
  it('crawler.json no longer gates it server-side', () => {
    expect(manifest.type).toBe('scim');
    expect(manifest).not.toHaveProperty('experimental');
  });

  it('CrawlerMeta.js no longer hides it from the picker or badges it', () => {
    expect(meta.id).toBe('scim');
    expect(meta).not.toHaveProperty('experimental');
  });

  it('agrees across both, under the same type id', () => {
    expect(meta.id).toBe(manifest.type);
    expect(!!meta.experimental).toBe(!!manifest.experimental);
  });
});
