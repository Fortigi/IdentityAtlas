// The crawler-metadata registry: what the Add-Crawler picker and the Admin →
// Experimental tab both read.
//
// The pure selectors are tested against hand-built fixtures (so the assertions
// stay true as crawler types come and go), plus one test against the REAL
// discovered registry — that one is what catches `experimental: true` being
// dropped from tools/crawlers/scim/CrawlerMeta.js.
import { describe, it, expect } from 'vitest';
import { CRAWLER_TYPES, experimentalCrawlerTypes, selectableCrawlerTypes, crawlerMetaFor } from './crawlerMetaRegistry.js';

const FIXTURES = [
  { id: 'entra-id', name: 'Entra ID' },
  { id: 'scim', name: 'SCIM 2.0', experimental: true },
  { id: 'csv', name: 'CSV' },
];

describe('experimentalCrawlerTypes', () => {
  it('returns only the flagged types', () => {
    expect(experimentalCrawlerTypes(FIXTURES).map(t => t.id)).toEqual(['scim']);
  });

  it('returns an empty list when nothing is flagged — the "no experimental crawlers" state', () => {
    expect(experimentalCrawlerTypes(FIXTURES.filter(t => !t.experimental))).toEqual([]);
  });
});

describe('selectableCrawlerTypes', () => {
  it('hides experimental types when the flag is off, keeping every ordinary type', () => {
    expect(selectableCrawlerTypes(false, FIXTURES).map(t => t.id)).toEqual(['entra-id', 'csv']);
  });

  it('offers experimental types when the flag is on', () => {
    expect(selectableCrawlerTypes(true, FIXTURES).map(t => t.id)).toEqual(['entra-id', 'scim', 'csv']);
  });

  it('treats a missing flag value as off — the picker must fail closed while /api/features is still loading', () => {
    expect(selectableCrawlerTypes(undefined, FIXTURES).map(t => t.id)).not.toContain('scim');
  });
});

describe('crawlerMetaFor', () => {
  it('finds a type by id', () => {
    expect(crawlerMetaFor('scim', FIXTURES).name).toBe('SCIM 2.0');
  });
  it('returns null for a type with no CrawlerMeta.js', () => {
    expect(crawlerMetaFor('nope', FIXTURES)).toBeNull();
  });
});

describe('the real discovered registry', () => {
  it('discovers every shipped crawler type, each with an id, name and description', () => {
    expect(CRAWLER_TYPES.length).toBeGreaterThan(1);
    for (const t of CRAWLER_TYPES) {
      expect(t.id, JSON.stringify(t)).toBeTruthy();
      expect(t.name, t.id).toBeTruthy();
      expect(t.description, t.id).toBeTruthy();
    }
  });

  it('marks SCIM experimental and nothing else', () => {
    expect(experimentalCrawlerTypes().map(t => t.id)).toEqual(['scim']);
  });

  it('drops SCIM from the picker with the flag off, and keeps the other types', () => {
    const off = selectableCrawlerTypes(false).map(t => t.id);
    expect(off).not.toContain('scim');
    expect(off).toContain('entra-id');
    expect(selectableCrawlerTypes(true).map(t => t.id)).toContain('scim');
  });
});
