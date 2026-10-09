import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');

import { queryOne } from '../../db/connection.js';
import { loadSourceEntities, SourceParsingUnavailable, defaultImporters } from './sourceEntities.js';

const SRC = '22222222-2222-4222-8222-222222222222';
const recipe = { version: 1, entities: [{ type: 'Person', nameColumn: 'Owner' }], relations: [] };

beforeEach(() => { queryOne.mockReset(); });

describe('loadSourceEntities', () => {
  it('parses the stored bytes with T1\'s parser and keeps only the asked entity type', async () => {
    const bytes = Buffer.from('Owner\nAnn');
    queryOne.mockResolvedValueOnce({ content: bytes, fileName: 'owners.csv', mimeType: 'text/csv' });
    const parseList = vi.fn(async () => ({ columns: ['Owner'], rows: [{ Owner: 'Ann' }] }));
    const applyRecipe = vi.fn(() => ({
      entities: [{ entityType: 'Person', displayName: 'Ann' }, { entityType: 'Project', displayName: 'Atlas' }],
    }));
    const out = await loadSourceEntities(
      { sourceId: SRC, recipe, entityType: 'Person' },
      { parse: async () => ({ parseList }), apply: async () => ({ applyRecipe }) },
    );
    expect(out).toEqual([{ entityType: 'Person', displayName: 'Ann' }]);
    expect(queryOne).toHaveBeenCalledWith(expect.stringMatching(/FROM "OrgSources" WHERE "id" = \$1/), [SRC]);
    expect(parseList).toHaveBeenCalledWith(bytes, { fileName: 'owners.csv', mimeType: 'text/csv' });
    expect(applyRecipe).toHaveBeenCalledWith([{ Owner: 'Ann' }], recipe);
  });

  it('gives null for an unknown source without importing anything', async () => {
    queryOne.mockResolvedValueOnce(null);
    const parse = vi.fn();
    expect(await loadSourceEntities({ sourceId: SRC, recipe, entityType: 'Person' }, { parse, apply: parse })).toBeNull();
    expect(parse).not.toHaveBeenCalled();
  });

  it('says parsing is unavailable when the import modules cannot be loaded', async () => {
    queryOne.mockResolvedValue({ content: Buffer.from(''), fileName: 'a.csv', mimeType: 'text/csv' });
    const missing = async () => { throw new Error('Cannot find module'); };
    const err = await loadSourceEntities({ sourceId: SRC, recipe, entityType: 'Person' }, { parse: missing, apply: missing }).catch(e => e);
    expect(err).toBeInstanceOf(SourceParsingUnavailable);
    expect(err.message).toBe('Parsing a stored source is not available yet (Cannot find module).');
  });

  it('copes with a recipe that yields no entities', async () => {
    queryOne.mockResolvedValueOnce({ content: Buffer.from(''), fileName: 'a.csv', mimeType: 'text/csv' });
    const out = await loadSourceEntities(
      { sourceId: SRC, recipe, entityType: 'Person' },
      { parse: async () => ({ parseList: async () => ({ rows: [] }) }), apply: async () => ({ applyRecipe: () => ({}) }) },
    );
    expect(out).toEqual([]);
  });

  it('default importers point at T1\'s import modules', () => {
    expect(Object.keys(defaultImporters)).toEqual(['parse', 'apply']);
  });
});
