// Unit tests for saved report views: what a view may store, and how it is
// served as a report. The db mock is SQL-blind, so the store's statements are
// asserted on what they bind; running them is the contract test's job.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/connection.js');
import { query, queryOne } from '../db/connection.js';
import { registerReport, resolveReport, listAllReports, reportMetadata } from './registry.js';
import {
  MAX_LIST, MAX_NAME, MAX_VALUE_LENGTH, VIEW_PREFIX,
  cleanParams, cleanValue, createView, deleteView, getView, isViewId, listViews, prepareView,
  toReportTemplate, updateView, viewSchema, viewableReport,
} from './views.js';

const ID = '33333333-3333-3333-3333-333333333333';

// A report the tests own, so nothing depends on a real template's parameters.
const run = vi.fn(async (params) => ({ rows: [{ seen: JSON.stringify(params) }] }));
const BASE = {
  name: 'test-viewable',
  displayName: 'Viewable',
  description: 'A report with parameters.',
  form: 'list',
  parametersSchema: {
    type: 'object',
    required: ['scope'],
    properties: {
      scope: { type: 'array', title: 'Scope' },
      columns: { type: 'array', title: 'Columns', default: ['a'] },
      days: { type: 'integer', title: 'Days' },
    },
  },
  columns: [{ key: 'seen', label: 'Seen' }],
  pivots: [{ name: 'P', rows: ['seen'], values: [] }],
  run,
};

const row = (over = {}) => ({
  id: ID, reportName: BASE.name, name: 'Ledger review', description: null,
  params: { scope: ['c1'], columns: ['x', 'y'] },
  createdBy: 'ann', updatedBy: 'bob', updatedAt: new Date('2026-10-16T08:00:00Z'),
  ...over,
});

let unregister;
beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  run.mockClear();
  unregister = registerReport(BASE);
});
afterEach(() => unregister());

describe('which reports can have views', () => {
  it('only a registered report that declares parameters', () => {
    expect(viewableReport(BASE.name)).toBe(BASE);
    expect(viewableReport('no-such-report')).toBeNull();
    expect(viewableReport(undefined)).toBeNull();
    const bare = registerReport({ ...BASE, name: 'test-bare', parametersSchema: { properties: {} } });
    const none = registerReport({ ...BASE, name: 'test-none', parametersSchema: undefined });
    try {
      expect(viewableReport('test-bare')).toBeNull();
      expect(viewableReport('test-none')).toBeNull();
    } finally { bare(); none(); }
  });
});

describe('what a view stores', () => {
  it('keeps text and lists of text, trimmed, and drops what is empty', () => {
    expect(cleanValue('  x ')).toBe('x');
    expect(cleanValue(['a ', '', 7, ' b'])).toEqual(['a', 'b']);
    expect(cleanValue(5)).toBe('5');
    expect(cleanValue(false)).toBe('false');
    for (const empty of ['  ', [], ['', '  '], null, undefined, { a: 1 }]) {
      expect(cleanValue(empty), JSON.stringify(empty)).toBeUndefined();
    }
  });

  it('caps a value and a list, because it is user input a template will run with', () => {
    expect(cleanValue('x'.repeat(MAX_VALUE_LENGTH + 10))).toHaveLength(MAX_VALUE_LENGTH);
    expect(cleanValue(Array.from({ length: MAX_LIST + 5 }, (_, i) => `v${i}`))).toHaveLength(MAX_LIST);
  });

  it('keeps only the parameters the report declares', () => {
    // An own `constructor` key is not a declared parameter either.
    expect(cleanParams(BASE, { scope: ['c1'], sneaky: 'x', days: 30, columns: [], constructor: 'y' }))
      .toEqual({ scope: ['c1'], days: '30' });
    expect(cleanParams(BASE, null)).toEqual({});
    expect(cleanParams(BASE, 'scope')).toEqual({});
  });

  it('prepares a create: name required and bounded, report must take parameters', () => {
    expect(prepareView({ reportName: BASE.name, name: '  Ledger  ', description: ' d ', params: { scope: 'c1' } }))
      .toEqual({ value: { reportName: BASE.name, name: 'Ledger', description: 'd', params: { scope: 'c1' } } });
    expect(prepareView({ reportName: BASE.name, name: 'x' }).value).toMatchObject({ description: null, params: {} });

    expect(prepareView({ reportName: BASE.name, name: '  ' }).errors).toEqual(['A name is required']);
    expect(prepareView({ reportName: BASE.name, name: 'x'.repeat(MAX_NAME + 1) }).errors)
      .toEqual([`The name is too long (max ${MAX_NAME} characters)`]);
    expect(prepareView({ reportName: 'nope', name: 'x' }).errors)
      .toEqual(['A view needs a standard report that takes parameters']);
    expect(prepareView(undefined).errors).toHaveLength(2);
  });

  it('keeps an update on the report it was made from, whatever the body says', () => {
    const { value } = prepareView({ reportName: 'something-else', name: 'x' }, { existingReportName: BASE.name });
    expect(value.reportName).toBe(BASE.name);
  });
});

describe('the store', () => {
  it('lists and gets views, and refuses an id that is not one without asking', async () => {
    query.mockResolvedValue({ rows: [row()] });
    expect(await listViews()).toEqual([row()]);
    queryOne.mockResolvedValue(row());
    expect(await getView(ID)).toEqual(row());
    expect(queryOne).toHaveBeenLastCalledWith(expect.stringContaining('WHERE "id" = $1'), [ID]);

    queryOne.mockClear();
    expect(await getView('nope')).toBeNull();
    expect(await updateView('nope', {}, 'ann')).toBeNull();
    expect(await deleteView('nope')).toBe(false);
    expect(queryOne).not.toHaveBeenCalled();
    expect(isViewId(ID)).toBe(true);
  });

  it('stores the params as JSON and the caller as both author and editor', async () => {
    queryOne.mockResolvedValue(row());
    await createView({ reportName: BASE.name, name: 'N', description: null, params: { scope: ['c1'] } }, 'ann');
    const [sql, params] = queryOne.mock.calls[0];
    expect(sql).toContain('INSERT INTO "ReportViews"');
    expect(params.slice(1)).toEqual([BASE.name, 'N', null, '{"scope":["c1"]}', 'ann']);
    expect(isViewId(params[0])).toBe(true);
  });

  it('updates name, description, params and editor — never the report', async () => {
    queryOne.mockResolvedValue(row());
    await updateView(ID, { reportName: 'ignored', name: 'N', description: 'd', params: {} }, 'bob');
    const [sql, params] = queryOne.mock.calls[0];
    expect(sql).not.toContain('"reportName" =');
    expect(params).toEqual([ID, 'N', 'd', '{}', 'bob']);
  });

  it('answers a duplicate name as a conflict and lets every other failure through', async () => {
    queryOne.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    expect(await createView({ params: {} }, 'ann')).toEqual({ conflict: true });
    queryOne.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    expect(await updateView(ID, { params: {} }, 'ann')).toEqual({ conflict: true });

    queryOne.mockRejectedValueOnce(new Error('down'));
    await expect(createView({ params: {} }, 'ann')).rejects.toThrow('down');
    queryOne.mockRejectedValueOnce(new Error('down'));
    await expect(updateView(ID, { params: {} }, 'ann')).rejects.toThrow('down');
  });

  it('reports whether a delete removed anything', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    expect(await deleteView(ID)).toBe(true);
    query.mockResolvedValueOnce({ rowCount: 0 });
    expect(await deleteView(ID)).toBe(false);
  });
});

describe('a view as a report', () => {
  it('opens with its own values as the defaults, and no longer requires what it fills', () => {
    const schema = viewSchema(BASE.parametersSchema, { scope: ['c1'] });
    expect(schema.properties.scope.default).toEqual(['c1']);
    // Untouched: the report's own default stands for what the view did not fill.
    expect(schema.properties.columns.default).toEqual(['a']);
    expect(schema.properties.days).toEqual({ type: 'integer', title: 'Days' });
    expect(schema.required).toEqual([]);
    expect(viewSchema({ properties: {} }, {}).required).toEqual([]);
    // The report's schema itself is not changed.
    expect(BASE.parametersSchema.properties.scope.default).toBeUndefined();
    expect(viewSchema(BASE.parametersSchema, {}).required).toEqual(['scope']);
  });

  it('is named and described as itself, and says which report it is a view of', () => {
    const template = toReportTemplate(row({ description: 'Our review' }));
    expect(template).toMatchObject({
      name: `${VIEW_PREFIX}${ID}`, displayName: 'Ledger review', description: 'Our review',
      form: 'list', source: 'view', columns: BASE.columns, pivots: BASE.pivots,
      view: { id: ID, reportName: BASE.name, reportDisplayName: 'Viewable' },
      author: { createdBy: 'ann', updatedBy: 'bob', updatedAt: '2026-10-16T08:00:00.000Z' },
    });
    // Without its own description it borrows the report's.
    expect(toReportTemplate(row()).description).toBe('A report with parameters.');
    expect(toReportTemplate(row({ createdBy: null, updatedBy: null, updatedAt: null })).author)
      .toEqual({ createdBy: null, updatedBy: null, updatedAt: null });
  });

  it('runs the report with the saved parameters, the run\'s own winning', async () => {
    const template = toReportTemplate(row());
    await template.run({ columns: 'z' }, { log: 'ctx' });
    expect(run).toHaveBeenCalledWith({ scope: ['c1'], columns: 'z' }, { log: 'ctx' });
    await template.run(undefined, {});
    expect(run).toHaveBeenLastCalledWith({ scope: ['c1'], columns: ['x', 'y'] }, {});
    await toReportTemplate(row({ params: null })).run({}, {});
    expect(run).toHaveBeenLastCalledWith({}, {});
  });

  it('disappears when the report it was a view of is gone', () => {
    expect(toReportTemplate(row({ reportName: 'retired-report' }))).toBeNull();
  });

  it('is listed and resolved through the registry, and its metadata says it is a view', async () => {
    query.mockResolvedValue({ rows: [row(), row({ id: '44444444-4444-4444-4444-444444444444', reportName: 'gone' })] });
    const listed = (await listAllReports()).filter(r => r.source === 'view');
    expect(listed.map(r => r.name)).toEqual([`${VIEW_PREFIX}${ID}`]);
    expect(reportMetadata(listed[0]).view).toEqual({ id: ID, reportName: BASE.name, reportDisplayName: 'Viewable' });

    queryOne.mockResolvedValue(row());
    expect((await resolveReport(`${VIEW_PREFIX}${ID}`)).displayName).toBe('Ledger review');
    queryOne.mockResolvedValue(null);
    expect(await resolveReport(`${VIEW_PREFIX}${ID}`)).toBeNull();
    // A name that is not a view's is not looked up.
    queryOne.mockClear();
    expect(await resolveReport('custom-nothing')).toBeNull();
    expect(queryOne).not.toHaveBeenCalledWith(expect.stringContaining('"ReportViews"'), expect.anything());
  });
});
