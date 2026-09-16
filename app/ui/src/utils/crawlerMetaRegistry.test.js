// The crawler-metadata registry: what the Add-Crawler picker and the Admin →
// Experimental tab both read.
//
// Deliberately names no crawler type. The selectors are tested against neutral
// fixtures, and the tests against the REAL discovered registry assert invariants
// that hold whatever this build happens to ship — a crawler type's own identity
// is pinned in its own folder (tools/crawlers/<type>/), which is also what the
// crawler-manifest CI gate requires of anything under app/ui/.
import { describe, it, expect } from 'vitest';
import { CRAWLER_TYPES, experimentalCrawlerTypes, selectableCrawlerTypes, crawlerMetaFor } from './crawlerMetaRegistry.js';

const FIXTURES = [
  { id: 'stable-one', name: 'Stable One' },
  { id: 'preview-one', name: 'Preview One', experimental: true },
  { id: 'stable-two', name: 'Stable Two' },
];

describe('experimentalCrawlerTypes', () => {
  it('returns only the flagged types', () => {
    expect(experimentalCrawlerTypes(FIXTURES).map(t => t.id)).toEqual(['preview-one']);
  });

  it('returns an empty list when nothing is flagged — the "no experimental crawlers" state', () => {
    expect(experimentalCrawlerTypes(FIXTURES.filter(t => !t.experimental))).toEqual([]);
  });
});

describe('selectableCrawlerTypes', () => {
  it('hides experimental types when the flag is off, keeping every ordinary type', () => {
    expect(selectableCrawlerTypes(false, FIXTURES).map(t => t.id)).toEqual(['stable-one', 'stable-two']);
  });

  it('offers experimental types when the flag is on, in the original order', () => {
    expect(selectableCrawlerTypes(true, FIXTURES).map(t => t.id)).toEqual(['stable-one', 'preview-one', 'stable-two']);
  });

  it('treats a missing flag value as off — the picker must fail closed while /api/features is still loading', () => {
    expect(selectableCrawlerTypes(undefined, FIXTURES).map(t => t.id)).not.toContain('preview-one');
  });
});

describe('crawlerMetaFor', () => {
  it('finds a type by id', () => {
    expect(crawlerMetaFor('preview-one', FIXTURES).name).toBe('Preview One');
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

  it('ships at least one experimental type, and every one of them is in the registry', () => {
    const experimental = experimentalCrawlerTypes();
    expect(experimental.length).toBeGreaterThan(0);
    for (const t of experimental) expect(CRAWLER_TYPES).toContain(t);
  });

  it('drops exactly the experimental types from the picker when the flag is off', () => {
    const off = selectableCrawlerTypes(false);
    const on = selectableCrawlerTypes(true);
    const experimentalIds = experimentalCrawlerTypes().map(t => t.id);

    expect(on.map(t => t.id)).toEqual(CRAWLER_TYPES.map(t => t.id));
    expect(off).toHaveLength(CRAWLER_TYPES.length - experimentalIds.length);
    // Not merely fewer — none of the dropped ones, and none of the others missing.
    for (const id of experimentalIds) expect(off.map(t => t.id)).not.toContain(id);
    expect(off.length).toBeGreaterThan(0);  // filtered, never emptied
  });
});
