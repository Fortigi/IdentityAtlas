/**
 * Tests for csv's crawler.json configSchema — no required fields; the optional
 * fields (csvFolder, systemName, systemType) are typed strings, plus the
 * delimiter / sourceFormat / per-file mapping section the wizard writes.
 * Exercised through the manifest-driven validateCrawlerConfig() engine.
 */
import { describe, it, expect } from 'vitest';
import { validateCrawlerConfig } from '@api/crawlerManifests.js';

const v = (config) => validateCrawlerConfig('csv', config);

describe('validateCrawlerConfig (csv)', () => {
  it('accepts an empty config (no required fields)', () => {
    expect(v({})).toBeNull();
  });

  it('accepts the optional fields', () => {
    expect(v({ csvFolder: '/data/csv', systemName: 'HR', systemType: 'csv' })).toBeNull();
  });

  it('errors when csvFolder has the wrong type', () => {
    expect(v({ csvFolder: 123 })).toMatch(/csvFolder/);
  });

  it('accepts a pre-mapping config — no sourceFormat, no files', () => {
    // Every config saved before column mapping existed is this shape. It must
    // keep validating, or editing or re-running an existing crawler breaks.
    expect(v({ systemName: 'CSV Import', systemType: 'CSV', delimiter: ';' })).toBeNull();
  });

  it('accepts the full mapped config the wizard writes', () => {
    expect(v({
      systemName: 'Active Directory',
      systemType: 'AD',
      delimiter: ';',
      sourceFormat: 'custom',
      files: {
        'ad_people.csv': { slot: 'users', delimiter: ',', columns: { ExternalId: 'samaccountname', DisplayName: 'cn' } },
        'ad_memberships.csv': {
          slot: 'assignments', delimiter: '\t',
          columns: { ResourceExternalId: 'group_dn', UserExternalId: 'members' },
          split: { field: 'UserExternalId', delimiter: ';' },
        },
      },
    })).toBeNull();
  });

  it('accepts the legacy two-character "\\t" delimiter a pre-fix wizard stored', () => {
    // The crawler normalizes it rather than rejecting it, so the schema must let
    // it through — otherwise such a config can no longer even be edited.
    expect(v({ delimiter: '\\t', files: { 'a.csv': { slot: 'users', delimiter: '\\t' } } })).toBeNull();
  });

  it('accepts a split stored as a list — the shape stays generic for later slices', () => {
    expect(v({ files: { 'a.csv': { slot: 'assignments', split: [{ field: 'UserExternalId', delimiter: ';' }] } } })).toBeNull();
  });

  it('rejects an unknown source format', () => {
    expect(v({ sourceFormat: 'guess-it' })).toMatch(/sourceFormat/);
  });

  it('rejects a mapping whose column value is not a column name', () => {
    expect(v({ files: { 'a.csv': { slot: 'users', columns: { ExternalId: 42 } } } })).toMatch(/columns/);
  });

  it('rejects an empty or over-long delimiter', () => {
    expect(v({ delimiter: '' })).toMatch(/delimiter/);
    expect(v({ delimiter: ';;;' })).toMatch(/delimiter/);
    expect(v({ files: { 'a.csv': { delimiter: '' } } })).toMatch(/delimiter/);
  });

  it('rejects a files section that is not a per-file object', () => {
    expect(v({ files: 'nonsense' })).toMatch(/files/);
    expect(v({ files: { 'a.csv': 'nonsense' } })).toMatch(/files/);
  });
});
