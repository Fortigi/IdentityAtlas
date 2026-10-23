// Unit tests for the application-permissions lookup source.
//
// The db mock is SQL-blind, so these assert on the parameters the source binds,
// the population its statement names, and the options it shapes. The option
// value is what the report later matches on, so its shape is the contract.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import source from './application-permissions.js';
import { BUILT_IN_LOOKUPS } from './index.js';

const GRAPH = '00000003-0000-0000-c000-000000000000';
const OTHER = '99999999-9999-9999-9999-999999999999';

const row = (over = {}) => ({ apiAppId: GRAPH, permission: 'User.Read.All', apiName: 'Microsoft Graph', holders: 4, ...over });
const paramsOf = () => query.mock.calls[0][1];
const sqlOf = () => String(query.mock.calls[0][0]);

beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [] }); });

it('is registered as a built-in lookup source', () => {
  expect(BUILT_IN_LOOKUPS).toContain(source);
  expect(source.name).toBe('application-permissions');
});

describe('application-permissions lookup — search', () => {
  it('offers a permission keyed by its API, labelled by its value, with API and holder count as hint', async () => {
    query.mockResolvedValue({ rows: [row()] });
    expect(await source.search({ q: '' })).toEqual([{
      value: `${GRAPH}|User.Read.All`, label: 'User.Read.All', hint: 'Microsoft Graph · 4 apps',
    }]);
  });

  it('says when a permission is already on the standard list', async () => {
    query.mockResolvedValue({ rows: [row({ permission: 'Mail.Read', holders: 1 })] });
    expect((await source.search({}))[0].hint).toBe('Microsoft Graph · 1 app · on the standard list');
  });

  it('names an API the shortlist does not know as the crawler named it, else by its appId', async () => {
    query.mockResolvedValue({ rows: [row({ apiAppId: OTHER, apiName: 'Contoso API' }), row({ apiAppId: OTHER, apiName: null, holders: null })] });
    const [named, bare] = await source.search({});
    expect(named.hint).toBe('Contoso API · 4 apps');
    expect(bare.hint).toBe(`${OTHER} · 0 apps`);
  });

  it('reads live granted application permissions only, and leaves out grants whose API is unknown', async () => {
    await source.search({ q: 'x' });
    const sql = sqlOf();
    expect(sql).toContain(`ap."resourceType" = 'ApplicationPermission'`);
    expect(sql).toContain(`ra."deletedAt" IS NULL AND ra."assignmentType" = 'Direct'`);
    expect(sql).toContain('g."apiAppId" IS NOT NULL');
    expect(sql).toContain('count(DISTINCT g.holder)');
  });

  it('escapes ILIKE wildcards and passes the limit, most widely held first', async () => {
    await source.search({ q: 'Mail_%', limit: 7 });
    expect(paramsOf()).toEqual(['Mail\\_\\%', 7]);
    expect(sqlOf()).toContain("ESCAPE '\\'");
    expect(sqlOf()).toMatch(/ORDER BY holders DESC/);
  });

  it('defaults to an empty search of twenty', async () => {
    await source.search({});
    expect(paramsOf()).toEqual(['', 20]);
  });
});

describe('application-permissions lookup — resolve', () => {
  it('looks stored keys up as (API, permission) pairs', async () => {
    query.mockResolvedValue({ rows: [row()] });
    const options = await source.resolve({ ids: [`${GRAPH}|User.Read.All`] });
    expect(paramsOf()).toEqual([[GRAPH], ['User.Read.All']]);
    expect(options).toEqual([{ value: `${GRAPH}|User.Read.All`, label: 'User.Read.All', hint: 'Microsoft Graph · 4 apps' }]);
  });

  it('still labels a key nobody holds any more, in the order it was stored', async () => {
    query.mockResolvedValue({ rows: [row()] });
    const options = await source.resolve({ ids: [`${OTHER}|Gone.All`, `${GRAPH}|User.Read.All`] });
    expect(options.map(o => o.value)).toEqual([`${OTHER}|Gone.All`, `${GRAPH}|User.Read.All`]);
    expect(options[0]).toEqual({ value: `${OTHER}|Gone.All`, label: 'Gone.All', hint: `${OTHER} · 0 apps` });
  });

  it('drops values that are not keys, and does not query when none are left', async () => {
    expect(await source.resolve({ ids: ['User.Read.All', 'x|y'] })).toEqual([]);
    expect(await source.resolve({})).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
