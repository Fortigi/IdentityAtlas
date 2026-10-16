import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import {
  parseSettings, parseTypeSettings, fromStored, readSettings, writeSettings, settingsFor, defaultsFor,
  SIGNALS_KEY, MAX_MONTHS, MAX_TYPES, MAX_VALUES, MAX_ATTRIBUTE_LENGTH,
} from './settings.js';

beforeEach(() => query.mockReset());

describe('parseTypeSettings', () => {
  it('fills missing fields with the defaults and trims', () => {
    expect(parseTypeSettings('Klant', {})).toEqual({ value: { inactiveAfterMonths: 6, statusAttribute: null, inactiveValues: ['true'] } });
    expect(parseTypeSettings('Klant', { inactiveAfterMonths: 12, statusAttribute: ' archief ', inactiveValues: [' Ja', 'Ja', 'true'] }))
      .toEqual({ value: { inactiveAfterMonths: 12, statusAttribute: 'archief', inactiveValues: ['Ja', 'true'] } });
  });

  it('months 1..120, whole', () => {
    expect(parseTypeSettings('K', { inactiveAfterMonths: 1 }).value).toBeTruthy();
    expect(parseTypeSettings('K', { inactiveAfterMonths: MAX_MONTHS }).value).toBeTruthy();
    for (const m of [0, MAX_MONTHS + 1, 2.5, '6']) expect(parseTypeSettings('K', { inactiveAfterMonths: m }).errors, String(m)).toHaveLength(1);
  });

  it('a status attribute is null or short text; values a short list of text', () => {
    expect(parseTypeSettings('K', { statusAttribute: 'a'.repeat(MAX_ATTRIBUTE_LENGTH) }).value).toBeTruthy();
    expect(parseTypeSettings('K', { statusAttribute: 'a'.repeat(MAX_ATTRIBUTE_LENGTH + 1) }).errors).toHaveLength(1);
    expect(parseTypeSettings('K', { statusAttribute: ' ' }).errors).toHaveLength(1);
    expect(parseTypeSettings('K', { inactiveValues: Array(MAX_VALUES).fill('x') }).value).toBeTruthy();
    expect(parseTypeSettings('K', { inactiveValues: Array(MAX_VALUES + 1).fill('x') }).errors).toHaveLength(1);
    expect(parseTypeSettings('K', { inactiveValues: ['ok', ''] }).errors).toHaveLength(1);
    expect(parseTypeSettings('K', { inactiveValues: 'true' }).errors).toHaveLength(1);
  });

  it('every problem at once, named by type', () => {
    const { errors } = parseTypeSettings('Klant', { inactiveAfterMonths: 0, statusAttribute: 5, inactiveValues: null });
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/^"Klant": inactiveAfterMonths/);
    expect(parseTypeSettings('Klant', [])).toEqual({ errors: ['Settings for "Klant" must be an object.'] });
  });
});

describe('parseSettings', () => {
  it('a map of types; null resets a type', () => {
    expect(parseSettings({ Klant: { inactiveAfterMonths: 3 }, Project: null })).toEqual({
      value: { Klant: { inactiveAfterMonths: 3, statusAttribute: null, inactiveValues: ['true'] }, Project: null },
    });
  });

  it('rejects a non-object, too many types, a blank type, and collects per-type errors', () => {
    expect(parseSettings([]).errors).toHaveLength(1);
    expect(parseSettings(null).errors).toHaveLength(1);
    const many = Object.fromEntries(Array.from({ length: MAX_TYPES + 1 }, (_, i) => [`T${i}`, {}]));
    expect(parseSettings(many).errors).toEqual([`At most ${MAX_TYPES} collection types.`]);
    expect(parseSettings({ ' ': {}, Klant: { inactiveAfterMonths: -1 } }).errors).toHaveLength(2);
  });
});

describe('fromStored', () => {
  it('keeps the valid types of a stored document; garbage reads as nothing stored', () => {
    expect(fromStored(JSON.stringify({ Klant: { inactiveAfterMonths: 9 }, Bad: { inactiveAfterMonths: 0 }, '': {} })))
      .toEqual({ Klant: { inactiveAfterMonths: 9, statusAttribute: null, inactiveValues: ['true'] } });
    expect(fromStored('not json')).toEqual({});
    expect(fromStored('[1]')).toEqual({});
  });
});

describe('read / write', () => {
  it('reads the WorkerConfig key; a type without settings gets the defaults', async () => {
    query.mockResolvedValue({ rows: [{ configValue: JSON.stringify({ Klant: { inactiveAfterMonths: 3 } }) }] });
    expect(await settingsFor('Klant')).toMatchObject({ inactiveAfterMonths: 3 });
    expect(await settingsFor('Project')).toEqual(defaultsFor());
    expect(query.mock.calls[0][1]).toEqual([SIGNALS_KEY]);
  });

  it('nothing stored is an empty map', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await readSettings()).toEqual({});
  });

  it('merges per type: changed types replace, null removes, others stay', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ configValue: JSON.stringify({ Klant: { inactiveAfterMonths: 3 }, Project: { inactiveAfterMonths: 4 }, Asset: { inactiveAfterMonths: 5 } }) }] })
      .mockResolvedValueOnce({ rows: [] });
    const out = await writeSettings({ Klant: { inactiveAfterMonths: 12, statusAttribute: 'archief', inactiveValues: ['true'] }, Project: null });
    expect(out).toEqual({
      Klant: { inactiveAfterMonths: 12, statusAttribute: 'archief', inactiveValues: ['true'] },
      Asset: { inactiveAfterMonths: 5, statusAttribute: null, inactiveValues: ['true'] },
    });
    const [sql, params] = query.mock.calls[1];
    expect(sql).toMatch(/ON CONFLICT \("configKey"\) DO UPDATE/);
    expect(params).toEqual([SIGNALS_KEY, JSON.stringify(out)]);
  });
});
