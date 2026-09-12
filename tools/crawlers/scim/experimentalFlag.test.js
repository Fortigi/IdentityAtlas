// SCIM ships as an EXPERIMENTAL crawler, and that has to be declared in TWO
// places that are read by two different layers:
//
//   crawler.json      "experimental": true  → the server-side gate
//                     (crawlerManifests.isExperimentalType → a 403 from
//                     POST /api/admin/crawler-configs)
//   CrawlerMeta.js    experimental: true    → the Add-Crawler picker filter
//                     and the Experimental badge
//
// Dropping either one half-graduates the crawler: still refused by the API but
// offered in the picker, or offered and creatable but shown as if it were a
// settled connector. This pins both, and that they agree.
//
// Lives here, not in app/ui/ or app/api/src/, because it is specific to one
// crawler type — see tools/crawlers/CLAUDE.md and the crawler-manifest CI gate.
import { describe, it, expect } from 'vitest';
import manifest from './crawler.json';
import meta from './CrawlerMeta.js';

describe('SCIM is declared experimental', () => {
  it('declares it in crawler.json — the server-side gate', () => {
    expect(manifest.type).toBe('scim');
    expect(manifest.experimental).toBe(true);
  });

  it('declares it in CrawlerMeta.js — the picker filter and the badge', () => {
    expect(meta.id).toBe('scim');
    expect(meta.experimental).toBe(true);
  });

  it('agrees across both, under the same type id', () => {
    expect(meta.id).toBe(manifest.type);
    expect(!!meta.experimental).toBe(!!manifest.experimental);
  });
});
