// This deployment's extendedAttributes keys as report fields. What this pins down:
//   • an attribute the static catalog already covers is not offered twice
//   • the RAW key is what a definition stores; the label is only what is shown
//   • the model is told about an attribute only when the question names it
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/columnCache.js', () => ({ discoverExtendedAttrKeys: vi.fn() }));
vi.mock('../lib/attributeLabels.js', () => ({ getAttributeLabels: vi.fn() }));

import { discoverExtendedAttrKeys } from '../db/columnCache.js';
import { getAttributeLabels } from '../lib/attributeLabels.js';
import {
  attributeFieldNames, attributesBlock, clearExtFieldsCache, extFieldsFor, loadExtFields, matchQuestionAttributes,
} from './extFields.js';

// A directory extension arrives under its wire name; the label is the readable tail.
const RAW = 'extension_a1b2c3d4e5f60718293a4b5c6d7e8f90_sfDepartmentID';
const LABELS = { [RAW]: 'sfDepartmentID' };

beforeEach(() => {
  clearExtFieldsCache();
  discoverExtendedAttrKeys.mockReset();
  getAttributeLabels.mockReset().mockResolvedValue({});
});

describe('extFieldsFor', () => {
  it('offers a discovered key as a text field that reads the raw JSON key', () => {
    const fields = extFieldsFor('user', [RAW], LABELS);
    const field = fields[`ext.${RAW}`];
    expect(Object.keys(fields)).toEqual([`ext.${RAW}`]);
    // Shown as the readable tail; addressed by the raw key, which is what a saved
    // report stores and what the SQL reads.
    expect(field.label).toBe('sfDepartmentID');
    expect(field.extKey).toBe(RAW);
    expect(field.type).toBe('text');
    expect(field.sql('t0')).toBe(`t0."extendedAttributes"->>'${RAW}'`);
    expect(field.discovered).toBe(true);
  });

  it('falls back to the raw key when nothing labelled it', () => {
    expect(extFieldsFor('user', ['sfCostCenterID'], {})['ext.sfCostCenterID'].label).toBe('sfCostCenterID');
  });

  it('leaves out keys a catalog field already reads, per entity', () => {
    // userType and employeeType are user/account fields; securityEnabled is a
    // resource one — so one key list yields different fields per entity.
    const user = extFieldsFor('user', ['userType', 'employeeType', 'securityEnabled', 'sfDepartmentID'], {});
    const resource = extFieldsFor('resource', ['userType', 'securityEnabled'], {});
    expect(Object.keys(user)).toEqual(['ext.securityEnabled', 'ext.sfDepartmentID']);
    expect(Object.keys(resource)).toEqual(['ext.userType']);
  });

  it('drops anything that is not a plain identifier, so nothing unsafe reaches the SQL', () => {
    // SAFE_KEY.test(undefined) tests the string "undefined" and passes, so the
    // type check has to come first.
    const hostile = `bad'); DROP TABLE "Principals"; --`;
    const fields = extFieldsFor('user', ['ok_1', hostile, 'has space', undefined, null, 42], {});
    expect(Object.keys(fields)).toEqual(['ext.ok_1']);
  });
});

describe('loadExtFields', () => {
  it('reads each table once and gives both entities that share it the same fields', async () => {
    discoverExtendedAttrKeys.mockImplementation(async (table) => ({
      Principals: ['sfDepartmentID'], Resources: ['fgGroupDN'], Identities: [],
    })[table]);

    const fields = await loadExtFields();

    expect(discoverExtendedAttrKeys.mock.calls.map(c => c[0])).toEqual(['Principals', 'Resources', 'Identities']);
    expect(Object.keys(fields.user)).toEqual(['ext.sfDepartmentID']);
    expect(Object.keys(fields.account)).toEqual(['ext.sfDepartmentID']);
    expect(Object.keys(fields.group)).toEqual(['ext.fgGroupDN']);
    expect(Object.keys(fields.resource)).toEqual(['ext.fgGroupDN']);
    expect(fields.identity).toEqual({});
  });

  it('labels a principal attribute from the principal target', async () => {
    discoverExtendedAttrKeys.mockResolvedValue([RAW]);
    getAttributeLabels.mockImplementation(async (target) => (target === 'principal' ? LABELS : {}));

    const fields = await loadExtFields();
    expect(fields.user[`ext.${RAW}`].label).toBe('sfDepartmentID');
    // The same key under Resources is labelled by the resource target, which has
    // nothing for it — so there it stays the raw key rather than borrowing one.
    expect(fields.resource[`ext.${RAW}`].label).toBe(RAW);
  });

  it('keeps the fields when the label lookup fails — a label is cosmetic', async () => {
    discoverExtendedAttrKeys.mockResolvedValue(['sfDepartmentID']);
    getAttributeLabels.mockRejectedValue(new Error('Systems table unreadable'));

    const fields = await loadExtFields();
    expect(fields.user['ext.sfDepartmentID'].label).toBe('sfDepartmentID');
  });

  it('lets a failed discovery through instead of quietly reporting on fewer fields', async () => {
    discoverExtendedAttrKeys.mockRejectedValue(new Error('connection terminated'));
    await expect(loadExtFields()).rejects.toThrow('connection terminated');
  });

  it('caches the discovery, and clearing the cache reads again', async () => {
    discoverExtendedAttrKeys.mockResolvedValue(['sfDepartmentID']);
    await loadExtFields();
    await loadExtFields();
    expect(discoverExtendedAttrKeys).toHaveBeenCalledTimes(3); // one per table, once

    clearExtFieldsCache();
    await loadExtFields();
    expect(discoverExtendedAttrKeys).toHaveBeenCalledTimes(6);
  });
});

describe('matchQuestionAttributes', () => {
  const extFields = {
    user: { ...extFieldsFor('user', [RAW], LABELS), ...extFieldsFor('user', ['sfTeamID'], {}) },
    account: extFieldsFor('account', [RAW], LABELS),
    group: extFieldsFor('group', ['fgGroupDN_OuPath'], { fgGroupDN_OuPath: 'OU path' }),
  };

  it('matches the label an analyst types, and reports every entity that has it', () => {
    const [match, ...rest] = matchQuestionAttributes('How many users per sfDepartmentID?', extFields);
    expect(rest).toEqual([]);
    expect(match).toEqual({ key: `ext.${RAW}`, label: 'sfDepartmentID', entities: ['user', 'account'] });
  });

  it('matches the raw key and the plural, and ignores case', () => {
    expect(matchQuestionAttributes(`group by ${RAW}`, extFields)[0].key).toBe(`ext.${RAW}`);
    expect(matchQuestionAttributes('list the SFDEPARTMENTIDS', extFields)[0].key).toBe(`ext.${RAW}`);
  });

  it('matches a label that is not one word', () => {
    expect(matchQuestionAttributes('count groups per OU path', extFields)[0].key).toBe('ext.fgGroupDN_OuPath');
  });

  it('does not match a word that merely contains the name', () => {
    expect(matchQuestionAttributes('what about sfTeamIDentifiers?', extFields)).toEqual([]);
  });

  it('finds nothing in a question that names no attribute, and nothing at all without fields', () => {
    expect(matchQuestionAttributes('how many users per department?', extFields)).toEqual([]);
    expect(matchQuestionAttributes('per sfDepartmentID', {})).toEqual([]);
  });

  it('stops at four attributes, however many the question names', () => {
    const many = { user: extFieldsFor('user', ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'], {}) };
    expect(matchQuestionAttributes('a1 b2 c3 d4 e5 f6', many)).toHaveLength(4);
  });
});

describe('attributesBlock', () => {
  it('names the field exactly as the model must write it', () => {
    const matches = matchQuestionAttributes('per sfDepartmentID', { user: extFieldsFor('user', [RAW], LABELS) });
    expect(attributesBlock(matches)).toContain(`- "sfDepartmentID" is the field ext.${RAW} (on user)`);
    expect(attributeFieldNames(matches)).toEqual([`ext.${RAW}`]);
  });

  it('says nothing when the question named no attribute', () => {
    expect(attributesBlock([])).toBe('');
    expect(attributeFieldNames([])).toEqual([]);
  });
});
