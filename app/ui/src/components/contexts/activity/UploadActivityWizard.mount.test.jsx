// @vitest-environment jsdom
// "Upload activity", mounted through its Actions card: who sees the card, then
// file → mapping (best guess, overridable, AI-marked) → preview → import, with
// the override in the body sent and the Activity section told to refresh.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement as h } from 'react';
import UploadActivityCard from './UploadActivityCard';
import { ACTIVITY_CHANGED } from './activityEvents';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent, within, waitFor } from '@ui/test-utils/renderWithProviders';

const ROOT = { id: 'root-1', displayName: 'Customers', contextCategory: 'OrganizationalUnit', targetType: 'Identity' };
const GUESS = {
  sourceLabel: 'Clockify', contextColumn: 'Client', subjectNameColumn: 'User', subjectEmailColumn: 'Email',
  dateColumn: 'Start Date', dateOrder: 'mdy', amountColumn: 'Duration (decimal)', unit: 'hours', kindColumn: 'Task',
  attributeColumns: ['Description'],
};
const HEADERS = ['Project', 'Client', 'Description', 'Task', 'User', 'Email', 'Start Date', 'Duration (decimal)'];
const ANALYSIS = {
  uploadDraftId: 'draft-1', fileName: 'clockify.csv', rowCount: 3, aiUsed: true, aiFields: ['kindColumn'], hasChildren: true, subUnitCount: 2,
  columns: HEADERS.map(header => ({ header, samples: [`${header} 1`] })), guess: GUESS, previousUpload: null,
};
const PREVIEW = {
  rowCount: 3, readable: 3, skipped: { 'no date': 1, 'no amount': 0, 'no person': 0 }, period: { start: '2026-01-15', end: '2026-04-18' }, unit: 'hours',
  contexts: { matched: 1, byName: 0, fuzzy: 1, unmatched: 1, ambiguous: 0, emptyRows: 0,
    fuzzySamples: [{ kind: 'Context', value: 'Contoso Bakeri', matched: 'Contoso Bakery' }],
    unmatchedSamples: [{ kind: 'Context', value: 'Unknown Ltd', reason: 'not found', rows: 4 }] },
  subjects: { matched: 2, byName: 1, fuzzy: 0, unmatched: 1, ambiguous: 0, fuzzySamples: [], unmatchedSamples: [{ kind: 'Identity', value: 'Ghost Person', reason: 'not found' }] },
  rowsToImport: 2, rowsNotPlaced: 1, rowsUnknownPerson: 1, subUnitsReached: 2,
  replaces: { rows: 7, uploads: [{ id: 'u-old', fileName: 'q1.csv', uploadedAt: '2026-04-01T10:00:00.000Z', rows: 7 }] },
  sample: [{ context: 'Northwind Traders', subject: 'Vera Example', date: '2026-04-18', amount: 1.5, kind: 'Build' }],
};

function api(overrides = {}) {
  return makeAuthFetch({
    'activity/analyze': ANALYSIS,
    'activity/preview': PREVIEW,
    'activity/apply': jsonResponse({ uploadId: 'u-new', imported: 2, replaced: 7, notImported: 1 }, { ok: true, status: 201 }),
    ...overrides,
  });
}

function mount({ authFetch = api(), auth = {} } = {}) {
  renderWithProviders(h(UploadActivityCard, { attrs: ROOT }), { auth: { authFetch, ...auth } });
  return { authFetch, user: userEvent.setup() };
}

const bodyOf = (authFetch, path) => JSON.parse(authFetch.mock.calls.find(([u]) => String(u).includes(path))[1].body);
const csvFile = () => new File(['Client;User\nNorthwind Traders;Vera Example'], 'clockify.csv', { type: 'text/csv' });

async function toMapping(user) {
  await user.click(screen.getByRole('button', { name: 'Upload activity…' }));
  expect(screen.getByRole('button', { name: 'Read the file ▸' })).toBeDisabled();
  await user.upload(screen.getByLabelText('Activity file'), csvFile());
  await user.click(screen.getByRole('button', { name: 'Read the file ▸' }));
  await screen.findByText(/3 rows in clockify\.csv\. This is a best guess, partly by the AI/);
}

afterEach(() => { vi.restoreAllMocks(); });

describe('Upload activity card', () => {
  it('is there for an analyst and gone for a reader without data.write.contexts', () => {
    mount();
    expect(screen.getByTestId('action-upload-activity')).toBeInTheDocument();
  });

  it('a business reader does not see it', () => {
    mount({ auth: { hasWildcard: false, permissions: new Set(['data.read']) } });
    expect(screen.queryByTestId('action-upload-activity')).toBeNull();
  });
});

describe('Upload activity wizard', () => {
  it('pre-fills the guess, marks the AI\'s field, offers the sub-unit column on a parent', async () => {
    const { user } = mount();
    await toMapping(user);
    expect(screen.getByRole('textbox', { name: 'Source' })).toHaveValue('Clockify');
    expect(screen.getByRole('combobox', { name: 'Sub-unit' })).toHaveValue('Client');
    expect(screen.getByRole('combobox', { name: 'Date' })).toHaveValue('Start Date');
    expect(screen.getByRole('combobox', { name: 'Dates are written' })).toHaveValue('mdy');
    expect(screen.getAllByTitle('Suggested by the AI — change it if it is wrong')).toHaveLength(1);
    expect(screen.getByText(/2 sub-units below it/)).toBeInTheDocument();
  });

  it('blocks the preview while the mapping has a problem, and says why', async () => {
    const { user } = mount();
    await toMapping(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Date' }), '');
    expect(screen.getByText('Choose the column that holds the date.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview ▸' })).toBeDisabled();
  });

  it('walks mapping → preview → import with the override in the body, then tells the page', async () => {
    const changed = vi.fn();
    window.addEventListener(ACTIVITY_CHANGED, changed);
    const { user, authFetch } = mount();
    await toMapping(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sub-unit' }), 'Project');
    await user.click(screen.getByRole('checkbox', { name: /^Client/ }));
    await user.click(screen.getByRole('button', { name: 'Preview ▸' }));

    expect(await screen.findByTestId('activity-import-line')).toHaveTextContent('2 rows to import on 2 units · 1 not placed · 1 by people not found');
    expect(screen.getByTestId('activity-units')).toHaveTextContent('Sub-units: 1 matched (1 fuzzy) · 1 not found');
    expect(screen.getByTestId('activity-skipped')).toHaveTextContent('1 without a date');
    expect(screen.getByText(/Replaces 7 rows of earlier uploads/)).toBeInTheDocument();
    expect(within(screen.getByTestId('activity-fuzzy-units')).getByText(/Contoso Bakeri → Contoso Bakery/)).toBeInTheDocument();
    expect(screen.getByText('Unknown Ltd')).toBeInTheDocument();
    expect(screen.getByText(/not found, 4 rows/)).toBeInTheDocument();
    const sent = bodyOf(authFetch, 'activity/preview');
    expect(sent).toEqual({ uploadDraftId: 'draft-1', mapping: { ...GUESS, contextColumn: 'Project', attributeColumns: ['Description', 'Client'] } });

    await user.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(changed.mock.calls[0][0].detail).toEqual({ contextId: 'root-1' });
    expect(bodyOf(authFetch, 'activity/apply').mapping.contextColumn).toBe('Project');
    expect(await screen.findByText('Imported 2 activity rows, 7 earlier rows replaced.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
    window.removeEventListener(ACTIVITY_CHANGED, changed);
  });

  it('a preview with nothing to import cannot be imported', async () => {
    const { user } = mount({ authFetch: api({ 'activity/preview': { ...PREVIEW, rowsToImport: 0 } }) });
    await toMapping(user);
    await user.click(screen.getByRole('button', { name: 'Preview ▸' }));
    expect(await screen.findByText('Nothing to import')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
  });

  it('shows the API\'s sentence when the file cannot be read, and stays on the file step', async () => {
    const authFetch = api({ 'activity/analyze': jsonResponse({ error: 'The file is empty.' }, { ok: false, status: 400 }) });
    const { user } = mount({ authFetch });
    await user.click(screen.getByRole('button', { name: 'Upload activity…' }));
    await user.upload(screen.getByLabelText('Activity file'), csvFile());
    await user.click(screen.getByRole('button', { name: 'Read the file ▸' }));
    expect(await screen.findByText('The file is empty.')).toBeInTheDocument();
    expect(screen.getByLabelText('Activity file')).toBeInTheDocument();
  });

  it('without an amount column the unit is fixed to events', async () => {
    const { user } = mount();
    await toMapping(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Amount' }), '');
    expect(screen.getByRole('combobox', { name: 'Unit' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveValue('events');
  });
});

describe('Upload activity wizard — moving around', () => {
  it('the source, the date order and the unit are the analyst\'s to change, and reach the API', async () => {
    const { user, authFetch } = mount();
    await toMapping(user);
    const source = screen.getByRole('textbox', { name: 'Source' });
    await user.clear(source);
    await user.type(source, 'Timesheets');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Dates are written' }), 'dmy');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Unit' }), 'events');
    await user.click(screen.getByRole('button', { name: 'Preview ▸' }));
    await screen.findByTestId('activity-import-line');
    expect(bodyOf(authFetch, 'activity/preview').mapping).toMatchObject({ sourceLabel: 'Timesheets', dateOrder: 'dmy', unit: 'events' });
  });

  it('Back and the stepper go to earlier steps; the close button closes', async () => {
    const { user } = mount();
    await toMapping(user);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Activity file')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Read the file ▸' }));
    await user.click(await screen.findByRole('button', { name: 'Preview ▸' }));
    await screen.findByTestId('activity-import-line');
    await user.click(screen.getByText('Mapping'));
    expect(screen.getByRole('textbox', { name: 'Source' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('textbox', { name: 'Source' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Upload activity…' })).toBeInTheDocument();
  });
});
