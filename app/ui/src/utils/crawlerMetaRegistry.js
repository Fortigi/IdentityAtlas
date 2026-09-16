// Crawler display metadata, auto-discovered by naming convention:
//   tools/crawlers/{type}/CrawlerMeta.js → { id, name, description, ... }
// Adding a crawler type never requires editing this file.
//
// Deliberately separate from the ConfigWizard.jsx / Summary.jsx globs in
// CrawlersPage: a component that only needs the metadata (Admin → Experimental)
// should not pull every wizard module into its bundle.

const _crawlerMetaModules = import.meta.glob('../../../../tools/crawlers/*/CrawlerMeta.js', { eager: true });

export const CRAWLER_TYPES = Object.values(_crawlerMetaModules).map(m => ({ ...m.default, available: true }));

// Crawler types flagged `experimental: true` in their CrawlerMeta.js — built and
// tested, but only lightly exercised against real-world endpoints. Shown on the
// Admin → Experimental tab so an operator can see exactly what the flag covers.
export function experimentalCrawlerTypes(types = CRAWLER_TYPES) {
  return types.filter(t => t.experimental);
}

// The types offered in the Add-Crawler picker. Experimental types appear only
// while the `experimentalCrawlers` feature flag is on. This is a UI filter only
// — POST /api/admin/crawler-configs enforces the same rule server-side, and an
// already-configured experimental crawler keeps working with the flag off.
export function selectableCrawlerTypes(experimentalEnabled, types = CRAWLER_TYPES) {
  return types.filter(t => !t.experimental || experimentalEnabled);
}

export function crawlerMetaFor(crawlerType, types = CRAWLER_TYPES) {
  return types.find(t => t.id === crawlerType) || null;
}
