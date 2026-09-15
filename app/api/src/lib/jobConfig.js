// Reserved job-config keys injected by the API when it queues a crawler job.
//
// A crawler receives exactly one thing from the API: the config blob stored on
// CrawlerJobs.config. Anything the run needs that isn't part of the operator's
// own settings has to be stamped onto that blob under an `_`-prefixed reserved
// key (`_syncMode`, `_scheduledByConfigId`, …). Crawlers ignore keys they don't
// know, so a new one is additive for every existing type.
//
// Lives here rather than in routes/jobs/helpers.js because both queue paths need
// it — the Run Now route and scheduler.js — and scheduler.js must not pull the
// route module's express/auth/filesystem dependencies in to get it.

// Stamp the crawler's own name (CrawlerConfigs.displayName) onto a job config,
// in place. Crawlers that register an Identity Atlas system read this so the
// system carries the name the operator gave the crawler rather than the crawler
// *type* — without it, a second crawler of the same type registers a second,
// identically-named system and renaming the crawler never renames the system
// (#1207). A blank or absent name stamps nothing, so the crawler's own default
// still applies. Returns the same object for convenience.
export function stampConfigName(configToStore, configName) {
  if (!configToStore) return configToStore;
  const trimmed = typeof configName === 'string' ? configName.trim() : '';
  if (trimmed) configToStore._configName = trimmed;
  return configToStore;
}
