/**
 * Unit tests for the CSV wizard's pure mapping + delimiter-detection rules.
 *
 * These are the rules a mapped import depends on, and the ones a regression
 * would break invisibly: a wrong tie rule silently reads a file with the wrong
 * delimiter, and validating the raw header instead of the mapped one flags every
 * mapped file as missing everything it was mapped to supply.
 *
 * Inputs are chosen to DISCRIMINATE (docs/contributing/writing-tests-that-assert.md):
 * the tie fixtures are ones where app/api's sniffDelimiter — fixed ';' > ',' >
 * TAB precedence — picks a DIFFERENT winner than the tie-to-config rule pinned
 * for this feature, so a copy-paste of that function would fail here.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DELIMITER,
  autoMapColumns,
  buildFilesConfig,
  canSplitField,
  delimiterLabel,
  detectDelimiter,
  duplicateMappedSources,
  extraColumnsNote,
  fileEntryFromConfig,
  isDefaultFileEntry,
  mapHeaderColumns,
  mappedPairs,
  mappingErrors,
  missingMappedColumns,
  missingRequiredColumns,
  normalizeDelimiter,
  parseCsvHeader,
  schemaColumnsFor,
  splitFromFields,
  unknownMappedColumns,
} from './csvMapping.js';

const TAB = '\t';

describe('normalizeDelimiter', () => {
  it('turns the legacy two-character "\\t" into a real tab', () => {
    // A JSX attribute does not process escapes, so <option value="\t"> stored a
    // backslash and a t — which no CSV reader could bind, so Tab-configured jobs
    // failed outright. A stored config in that shape must still work.
    expect(normalizeDelimiter('\\t')).toBe(TAB);
    expect(normalizeDelimiter('\\t')).toHaveLength(1);
  });

  it('passes a real delimiter through and maps nothing to ""', () => {
    expect(normalizeDelimiter(';')).toBe(';');
    expect(normalizeDelimiter(TAB)).toBe(TAB);
    expect(normalizeDelimiter('')).toBe('');
    expect(normalizeDelimiter(undefined)).toBe('');
  });
});

describe('delimiterLabel', () => {
  it('names each delimiter, and falls back to the default for an unknown one', () => {
    expect(delimiterLabel(TAB)).toBe('Tab');
    expect(delimiterLabel('\\t')).toBe('Tab');
    expect(delimiterLabel(';')).toBe('Semicolon (;)');
    expect(delimiterLabel(undefined)).toBe(DEFAULT_DELIMITER);
  });
});

describe('detectDelimiter', () => {
  it('picks the candidate that yields the most columns', () => {
    expect(detectDelimiter('a,b,c', ';')).toBe(',');
    expect(detectDelimiter('a;b;c', ',')).toBe(';');
    expect(detectDelimiter(`a${TAB}b${TAB}c`, ';')).toBe(TAB);
  });

  it('keeps the config-level delimiter for a single-column file', () => {
    // Every candidate yields exactly one column, so the file says nothing. The
    // step-1 choice stays the answer rather than a fixed precedence order.
    expect(detectDelimiter('OnlyColumn', ',')).toBe(',');
    expect(detectDelimiter('OnlyColumn', TAB)).toBe(TAB);
  });

  it('keeps the config-level delimiter on a tie — NOT a fixed precedence', () => {
    // 'a;b,c' splits into two either way. app/api's sniffDelimiter would answer
    // ';' here whatever the config said; this rule answers the config.
    expect(detectDelimiter('a;b,c', ',')).toBe(',');
    expect(detectDelimiter('a;b,c', ';')).toBe(';');
    expect(detectDelimiter('a;b,c', '|')).toBe('|');
  });

  it('normalizes a legacy "\\t" fallback instead of returning it verbatim', () => {
    expect(detectDelimiter('OnlyColumn', '\\t')).toBe(TAB);
  });

  it('falls back to the config delimiter for an empty or missing header', () => {
    expect(detectDelimiter('', ',')).toBe(',');
    expect(detectDelimiter(undefined, ',')).toBe(',');
  });

  it('sees through a BOM and quoted header cells', () => {
    expect(detectDelimiter('﻿"a","b","c"', ';')).toBe(',');
  });

  it('never auto-detects pipe — it stays manually selectable only', () => {
    expect(detectDelimiter('a|b|c', ';')).toBe(';');
  });
});

describe('schemaColumnsFor', () => {
  it('derives a slot\'s fields from its shipped schema template', () => {
    // Read from schema/Users.csv, so the mapping panel can never drift from the
    // templates Admin → Crawlers hands out.
    expect(schemaColumnsFor('users')).toEqual([
      'ExternalId', 'DisplayName', 'Email', 'EmployeeId', 'GivenName', 'Surname',
      'PrincipalType', 'JobTitle', 'Department', 'ManagerExternalId', 'SystemName', 'Enabled',
    ]);
    expect(schemaColumnsFor('assignments')).toEqual([
      'ResourceExternalId', 'UserExternalId', 'AssignmentType', 'SystemName',
    ]);
  });

  it('returns [] for an unknown slot', () => {
    expect(schemaColumnsFor('nope')).toEqual([]);
    expect(schemaColumnsFor(null)).toEqual([]);
  });
});

describe('autoMapColumns', () => {
  it('pre-fills by exact, case-insensitive name match and leaves the rest unmapped', () => {
    const map = autoMapColumns(['externalid', 'FULL_NAME', 'mail'], 'users');
    expect(map.ExternalId).toBe('externalid');
    expect(map.DisplayName).toBe('');       // no fuzzy guess from FULL_NAME
    expect(map.Email).toBe('');             // "mail" is not "Email"
    // Every schema field is present as a key, so the panel renders a row for each.
    expect(Object.keys(map)).toEqual(schemaColumnsFor('users'));
  });

  it('returns {} for a file with no slot', () => {
    expect(autoMapColumns(['a'], null)).toEqual({});
  });
});

describe('mapHeaderColumns', () => {
  it('renames mapped columns and keeps unmapped ones under their source names', () => {
    const header = ['samaccountname', 'cn', 'physicalDeliveryOfficeName'];
    expect(mapHeaderColumns(header, { ExternalId: 'samaccountname', DisplayName: 'cn' }))
      .toEqual(['ExternalId', 'DisplayName', 'physicalDeliveryOfficeName']);
  });

  it('matches case-insensitively and ignores empty mappings', () => {
    expect(mapHeaderColumns(['SAMAccountName'], { ExternalId: 'samaccountname' })).toEqual(['ExternalId']);
    expect(mapHeaderColumns(['a', 'b'], { ExternalId: '' })).toEqual(['a', 'b']);
    expect(mapHeaderColumns(['a'], null)).toEqual(['a']);
  });
});

describe('missingMappedColumns — the post-mapping check', () => {
  it('reports a required schema field no column is mapped to', () => {
    expect(missingMappedColumns(['emp_no', 'full_name'], { ExternalId: 'emp_no' }, ['ExternalId', 'DisplayName']))
      .toEqual(['DisplayName']);
  });

  it('reports nothing once the mapping covers the required fields', () => {
    // The regression this pins: checking the RAW header here reports both
    // ExternalId and DisplayName missing from every mapped file there is.
    expect(missingMappedColumns(['emp_no', 'full_name'],
      { ExternalId: 'emp_no', DisplayName: 'full_name' }, ['ExternalId', 'DisplayName'])).toEqual([]);
  });

  it('still reports them for a schema-shaped file with no mapping at all', () => {
    expect(missingRequiredColumns(parseCsvHeader('ExternalId;Email', ';'), ['ExternalId', 'DisplayName']))
      .toEqual(['DisplayName']);
  });
});

describe('unknownMappedColumns / duplicateMappedSources', () => {
  it('names a mapped column the file does not have', () => {
    expect(unknownMappedColumns(['cn'], { ExternalId: 'samaccountname', DisplayName: 'cn' }))
      .toEqual(['samaccountname']);
    expect(unknownMappedColumns(['SAMAccountName'], { ExternalId: 'samaccountname' })).toEqual([]);
  });

  it('names a column two schema fields both claim', () => {
    expect(duplicateMappedSources({ ExternalId: 'id', DisplayName: 'id' })).toEqual(['id']);
    expect(duplicateMappedSources({ ExternalId: 'id', DisplayName: 'cn' })).toEqual([]);
  });
});

describe('mappingErrors', () => {
  const header = ['emp_no', 'full_name'];

  it('is empty for a mapping that covers the slot\'s required fields', () => {
    expect(mappingErrors(header, { ExternalId: 'emp_no', DisplayName: 'full_name' }, 'users')).toEqual([]);
  });

  it('names the unmapped required schema fields', () => {
    const [msg] = mappingErrors(header, { ExternalId: 'emp_no' }, 'users');
    expect(msg).toMatch(/Unmapped required field: DisplayName/);
  });

  it('names a mapped column the file no longer has', () => {
    const msgs = mappingErrors(header, { ExternalId: 'staff_id', DisplayName: 'full_name' }, 'users');
    expect(msgs.join(' ')).toMatch(/not in the file: staff_id/);
  });

  it('names a column mapped to more than one field', () => {
    const msgs = mappingErrors(header, { ExternalId: 'emp_no', DisplayName: 'emp_no' }, 'users');
    expect(msgs.join(' ')).toMatch(/mapped to more than one field: emp_no/);
  });

  it('says nothing about a file with no slot', () => {
    expect(mappingErrors(header, {}, null)).toEqual([]);
  });
});

describe('extraColumnsNote', () => {
  it('says extras are kept for a slot whose table has extendedAttributes', () => {
    expect(extraColumnsNote('users')).toMatch(/kept as extended attributes/);
  });

  it('says extras are ignored (and logged) for the three slots that drop them', () => {
    for (const slot of ['assignments', 'identityMembers', 'context-members']) {
      expect(extraColumnsNote(slot)).toMatch(/ignored .* named in the job log/);
    }
  });
});

describe('splitFromFields / canSplitField', () => {
  it('offers a split only on the Assignments slot\'s two identifying fields', () => {
    expect(canSplitField('assignments', 'UserExternalId')).toBe(true);
    expect(canSplitField('assignments', 'ResourceExternalId')).toBe(true);
    expect(canSplitField('assignments', 'AssignmentType')).toBe(false);
    expect(canSplitField('users', 'UserExternalId')).toBe(false);
  });

  it('builds the one split a file declares', () => {
    expect(splitFromFields('assignments', { UserExternalId: ';' })).toEqual({ field: 'UserExternalId', delimiter: ';' });
    expect(splitFromFields('assignments', { UserExternalId: '' })).toBeNull();
    expect(splitFromFields('users', { UserExternalId: ';' })).toBeNull();
  });
});

describe('isDefaultFileEntry', () => {
  it('treats a canonically-named, config-delimiter, unmapped file as saying nothing', () => {
    expect(isDefaultFileEntry({ name: 'Users.csv', slot: 'users', delimiter: ';', columns: {} }, ';')).toBe(true);
  });

  it('keeps an entry for a non-canonical filename — the crawler needs the slot', () => {
    // Omitting this is how ad_users.csv would never be read: the phase asks for
    // Users.csv, which is not there.
    expect(isDefaultFileEntry({ name: 'ad_users.csv', slot: 'users', delimiter: ';', columns: {} }, ';')).toBe(false);
  });

  it('keeps an entry whose delimiter, mapping or split differs from the default', () => {
    expect(isDefaultFileEntry({ name: 'Users.csv', slot: 'users', delimiter: ',', columns: {} }, ';')).toBe(false);
    expect(isDefaultFileEntry({ name: 'Users.csv', slot: 'users', delimiter: ';', columns: { ExternalId: 'id' } }, ';')).toBe(false);
    expect(isDefaultFileEntry({ name: 'Users.csv', slot: 'users', delimiter: ';', columns: {}, split: { field: 'x', delimiter: ';' } }, ';')).toBe(false);
  });

  it('compares the legacy "\\t" and a real tab as the same delimiter', () => {
    expect(isDefaultFileEntry({ name: 'Users.csv', slot: 'users', delimiter: TAB, columns: {} }, '\\t')).toBe(true);
  });
});

describe('buildFilesConfig', () => {
  const staged = (over = {}) => ({ name: 'ad_people.csv', slot: 'users', delimiter: ',', mapping: { ExternalId: 'samaccountname', DisplayName: '' }, splitDelimiters: {}, ...over });

  it('stores slot, delimiter and only the columns that actually map', () => {
    const files = buildFilesConfig([staged()], { defaultDelimiter: ';', sourceFormat: 'custom' });
    expect(files['ad_people.csv']).toEqual({
      slot: 'users', delimiter: ',', columns: { ExternalId: 'samaccountname' },
    });
  });

  it('writes no mapping at all in Identity Atlas-schema mode', () => {
    const files = buildFilesConfig([staged()], { defaultDelimiter: ';', sourceFormat: 'identityatlas' });
    expect(files['ad_people.csv']).toEqual({ slot: 'users', delimiter: ',' });
  });

  it('leaves out a schema-shaped file entirely — the bypass path stays untouched', () => {
    const entries = [
      { name: 'Users.csv', slot: 'users', delimiter: ';', mapping: {}, splitDelimiters: {} },
      { name: 'Resources.csv', slot: 'resources', delimiter: ';', mapping: {}, splitDelimiters: {} },
    ];
    expect(buildFilesConfig(entries, { defaultDelimiter: ';', sourceFormat: 'identityatlas' })).toEqual({});
  });

  it('keeps a schema-named file that needs its own delimiter', () => {
    const files = buildFilesConfig(
      [{ name: 'Users.csv', slot: 'users', delimiter: TAB, mapping: {}, splitDelimiters: {} }],
      { defaultDelimiter: ';', sourceFormat: 'identityatlas' },
    );
    expect(files['Users.csv']).toEqual({ slot: 'users', delimiter: TAB });
  });

  it('stores a split on the Assignments slot only', () => {
    const entries = [
      { name: 'memberships.csv', slot: 'assignments', delimiter: ';', mapping: { UserExternalId: 'members' }, splitDelimiters: { UserExternalId: ';' } },
      { name: 'people.csv', slot: 'users', delimiter: ';', mapping: { ExternalId: 'id' }, splitDelimiters: { UserExternalId: ';' } },
    ];
    const files = buildFilesConfig(entries, { defaultDelimiter: ';', sourceFormat: 'custom' });
    expect(files['memberships.csv'].split).toEqual({ field: 'UserExternalId', delimiter: ';' });
    expect(files['people.csv'].split).toBeUndefined();
  });

  it('skips a file the user set to "— Ignore —": nothing reads it', () => {
    expect(buildFilesConfig([staged({ slot: null })], { defaultDelimiter: ';', sourceFormat: 'custom' })).toEqual({});
    expect(buildFilesConfig([{ slot: 'users' }], { defaultDelimiter: ';' })).toEqual({});
    expect(buildFilesConfig(null)).toEqual({});
  });
});

describe('fileEntryFromConfig', () => {
  const stored = {
    'ad_people.csv': { slot: 'users', delimiter: ',', columns: { ExternalId: 'samaccountname' } },
    'memberships.csv': { slot: 'assignments', split: { field: 'UserExternalId', delimiter: ';' } },
    'listed.csv': { slot: 'assignments', split: [{ field: 'ResourceExternalId', delimiter: '|' }] },
  };

  it('round-trips a stored entry back into the wizard\'s per-file state', () => {
    expect(fileEntryFromConfig('ad_people.csv', stored, ';')).toEqual({
      name: 'ad_people.csv', slot: 'users', delimiter: ',',
      mapping: { ExternalId: 'samaccountname' }, splitDelimiters: {},
    });
  });

  it('restores a split, whether stored as an object or a one-element list', () => {
    expect(fileEntryFromConfig('memberships.csv', stored, ';').splitDelimiters).toEqual({ UserExternalId: ';' });
    expect(fileEntryFromConfig('listed.csv', stored, ';').splitDelimiters).toEqual({ ResourceExternalId: '|' });
  });

  it('gives a file the config says nothing about the config-level delimiter', () => {
    expect(fileEntryFromConfig('Users.csv', stored, TAB)).toEqual({
      name: 'Users.csv', slot: null, delimiter: TAB, mapping: {}, splitDelimiters: {},
    });
    expect(fileEntryFromConfig('Users.csv', null, '\\t').delimiter).toBe(TAB);
  });
});

describe('mappedPairs', () => {
  it('keeps only the fields that map to something', () => {
    expect(mappedPairs({ a: 'x', b: '', c: null })).toEqual([['a', 'x']]);
    expect(mappedPairs(null)).toEqual([]);
  });
});
