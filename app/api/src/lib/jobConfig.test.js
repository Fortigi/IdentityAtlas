import { describe, it, expect } from 'vitest';
import { stampConfigName } from './jobConfig.js';

// The two queue paths (routes/jobs/runs.js and scheduler.js) drive this through
// prepareJobConfig / queueScheduledJob, and both are covered there. These cases
// are the helper's own decisions, chosen so that a wrong one fails: a name that
// only differs from the stored value by whitespace, a non-string, and a config
// that isn't an object at all.
describe('stampConfigName', () => {
  it('stamps the crawler name under the reserved _configName key', () => {
    expect(stampConfigName({ baseUrl: 'https://h/scim' }, 'ABC'))
      .toEqual({ baseUrl: 'https://h/scim', _configName: 'ABC' });
  });

  it('trims the name rather than storing the operator\'s stray whitespace', () => {
    // A system named " ABC " reads as "ABC" everywhere it is displayed, so an
    // untrimmed stamp is a bug nobody can see until they filter on the name.
    expect(stampConfigName({}, '  ABC  ')._configName).toBe('ABC');
  });

  it('stamps nothing for a name that is only whitespace', () => {
    expect(stampConfigName({ pageSize: 100 }, '   ')).not.toHaveProperty('_configName');
  });

  it('stamps nothing when no name was supplied', () => {
    expect(stampConfigName({}, undefined)).not.toHaveProperty('_configName');
    expect(stampConfigName({}, null)).not.toHaveProperty('_configName');
  });

  it('ignores a non-string name instead of stamping its coerced form', () => {
    // resolveJobConfig hands over whatever CrawlerConfigs.displayName held. A
    // number would otherwise be stamped as "42" — or throw on .trim().
    expect(stampConfigName({}, 42)).not.toHaveProperty('_configName');
  });

  it('leaves the rest of the config untouched', () => {
    const cfg = { baseUrl: 'https://h/scim', _syncMode: 'full', _scheduledByConfigId: 7 };
    stampConfigName(cfg, 'ABC');
    expect(cfg).toEqual({ baseUrl: 'https://h/scim', _syncMode: 'full', _scheduledByConfigId: 7, _configName: 'ABC' });
  });

  it('stamps in place and returns the same object, not a copy', () => {
    // prepareJobConfig relies on this: it serialises `configToStore` after the
    // call, so a helper that returned a new object would silently stamp nothing.
    const cfg = {};
    expect(stampConfigName(cfg, 'ABC')).toBe(cfg);
  });

  it('passes a missing config straight through', () => {
    // An inline job with no config at all: prepareJobConfig stores null, and the
    // stamp must not turn that into an object.
    expect(stampConfigName(null, 'ABC')).toBe(null);
    expect(stampConfigName(undefined, 'ABC')).toBe(undefined);
  });
});
