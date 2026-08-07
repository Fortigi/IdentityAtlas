// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import MatrixFilterSummary from './MatrixFilterSummary';
import {
  renderWithProviders, makeAuthFetch, jsonResponse,
  screen, waitFor, userEvent,
} from '@ui/test-utils/renderWithProviders';

// The org-wide default the demo dataset seeds: four fields, nothing else.
const seededFilter = {
  rowType: 'principal',
  orientation: 'rows-as-resources',
  subject: { include: [], exclude: [] },
  resource: { include: [], exclude: [] },
};

// What the wizard applies after adjusting that matrix without changing
// anything: the same matrix, in the full normalised shape.
const adjustedFilter = {
  ...seededFilter,
  rollup: null,
  rollupContent: 'resources-and-roles',
  rollupMetric: 'count',
  rollupKind: 'attribute',
  rollupContextId: null,
  rollupPath: [],
  rollupExpanded: [],
  rollupCollapsed: [],
  foldAttributes: false,
  sortAttributes: [{ attribute: 'department', dir: 'asc' }],
  sortHierarchy: null,
  foldOnLoad: 'auto',
};

// Declared outside the array literal: an { id, name, description } object
// inside one trips the no-hardcoded-crawler-meta lint rule.
const demoDefaultRow = {
  id: 'sf-1',
  name: 'Fortigi Demo Corp — All',
  description: 'Demo default',
  filter: seededFilter,
};
const savedRows = [
  demoDefaultRow,
  { id: 'sf-2', name: 'HR users', filter: { ...seededFilter, subject: { include: [{ kind: 'attribute', field: 'department', values: ['HR'] }], exclude: [] } } },
];

const preview = { subjectCount: 45, subjectTotal: 45, resourceCount: 39, resourceTotal: 39, assignmentCount: 143 };

function makeFetch({ saved = savedRows, contexts = {} } = {}) {
  return makeAuthFetch((url) => {
    const u = String(url);
    if (u.includes('/api/matrix/saved-filters')) return jsonResponse(saved);
    const ctx = Object.keys(contexts).find(id => u.includes(id));
    if (ctx) return jsonResponse({ attributes: { id: ctx, displayName: contexts[ctx] } });
    return undefined;
  });
}

function renderSummary(filter, { authFetch = makeFetch(), onAdjust = vi.fn() } = {}) {
  const result = renderWithProviders(
    h(MatrixFilterSummary, { filter, preview, onAdjust }),
    { auth: { authFetch } },
  );
  return { ...result, onAdjust };
}

describe('MatrixFilterSummary (mounted)', () => {
  it('renders nothing without a filter', () => {
    const { container } = renderSummary(null);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the scope, the preview counts and an Adjust matrix button', async () => {
    const { onAdjust } = renderSummary(seededFilter);
    expect(screen.getByText('User × Resource')).toBeInTheDocument();
    expect(screen.getByText('(45/45)')).toBeInTheDocument();
    expect(screen.getByText('(39/39)')).toBeInTheDocument();
    expect(screen.getByText('143')).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Adjust matrix' }));
    expect(onAdjust).toHaveBeenCalled();
  });

  it('labels the matrix with the saved matrix it came from', async () => {
    renderSummary(seededFilter);
    expect(await screen.findByText('Fortigi Demo Corp — All')).toBeInTheDocument();
  });

  it('keeps that label after an adjust that changed nothing', async () => {
    // The applied filter is the normalised shape of the stored one. Comparing
    // raw JSON relabelled it "Not saved" the moment the analyst opened the
    // wizard and applied without touching a control.
    renderSummary(adjustedFilter);
    expect(await screen.findByText('Fortigi Demo Corp — All')).toBeInTheDocument();
    expect(screen.queryByText('Not saved')).not.toBeInTheDocument();
  });

  it('keeps that label while the analyst folds and drills the matrix', async () => {
    renderSummary({
      ...adjustedFilter,
      rollupExpanded: ['node-1'],
      rollupCollapsed: ['0|8:Everyone'],
      rollupPath: ['node-1'],
      foldAttributes: true,
    });
    expect(await screen.findByText('Fortigi Demo Corp — All')).toBeInTheDocument();
  });

  it('marks a matrix that matches no saved one as "Not saved"', async () => {
    renderSummary({ ...adjustedFilter, rowType: 'identity' });
    expect(await screen.findByText('Not saved')).toBeInTheDocument();
    expect(screen.getByText('Identity × Resource')).toBeInTheDocument();
  });

  it('renders attribute and exclude conditions as chips', async () => {
    renderSummary({
      ...adjustedFilter,
      subject: {
        include: [{ kind: 'attribute', field: 'department', values: ['HR', 'Finance'] }],
        exclude: [{ kind: 'attribute', field: 'accountEnabled', values: ['false'] }],
      },
    });
    expect(await screen.findByText('department: HR, Finance')).toBeInTheDocument();
    expect(screen.getByText('accountEnabled: false')).toBeInTheDocument();
    expect(screen.getByText('NOT')).toBeInTheDocument();
  });

  it('resolves context conditions to their display name', async () => {
    const authFetch = makeFetch({ contexts: { 'ctx-1': 'Engineering' } });
    renderSummary({
      ...adjustedFilter,
      resource: { include: [{ kind: 'context', contextId: 'ctx-1', includeChildren: true }], exclude: [] },
    }, { authFetch });

    expect(await screen.findByText('Engineering +sub')).toBeInTheDocument();
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/contexts/ctx-1'));
  });

  it('falls back to "Not saved" when the saved-matrix list cannot be loaded', async () => {
    const authFetch = makeAuthFetch(() => jsonResponse({ error: 'nope' }, { ok: false, status: 500 }));
    renderSummary(adjustedFilter, { authFetch });
    expect(await screen.findByText('Not saved')).toBeInTheDocument();
  });
});
