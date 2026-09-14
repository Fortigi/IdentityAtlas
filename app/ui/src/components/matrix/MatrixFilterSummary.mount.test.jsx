// @vitest-environment jsdom
//
// The strip above the matrix (#1202):
//   [<name> ▾] [Unsaved changes] [Shared with N ▾] ····· 45 users × 39 resources · 143 cells [Adjust]
// The name menu's own behaviour is MatrixNameBar.mount.test.jsx; this file is
// about the strip as a whole — what it holds, what it no longer holds, and the
// fingerprint rules that decide which name it shows.
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import MatrixFilterSummary from './MatrixFilterSummary';
import { SharedViewContext } from '@ui/contexts/SharedViewContext';
import {
  renderWithProviders, makeAuthFetch, jsonResponse,
  screen, userEvent,
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

const preview = { subjectCount: 45, subjectTotal: 50, resourceCount: 39, resourceTotal: 41, assignmentCount: 143 };

function makeFetch({ saved = savedRows } = {}) {
  return makeAuthFetch((url) => (String(url).includes('/api/matrix/saved-filters') ? jsonResponse(saved) : undefined));
}

function renderSummary(filter, { authFetch = makeFetch(), onAdjust = vi.fn(), counts = preview, sharedView = false } = {}) {
  const strip = h(MatrixFilterSummary, { filter, preview: counts, onAdjust });
  const result = renderWithProviders(
    sharedView ? h(SharedViewContext.Provider, { value: true }, strip) : strip,
    { auth: { authFetch }, features: { matrixSharing: true } },
  );
  return { ...result, onAdjust, authFetch };
}

describe('MatrixFilterSummary — the strip (mounted)', () => {
  it('renders nothing without a filter', () => {
    const { container } = renderSummary(null);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing — and fetches nothing — for a share recipient', () => {
    const { container, authFetch } = renderSummary(seededFilter, { sharedView: true });
    expect(container).toBeEmptyDOMElement();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('shows the three live counts and one Adjust button that opens the wizard as usual', async () => {
    const { onAdjust } = renderSummary(seededFilter);
    // Selected counts, not the totals they are "of".
    expect(screen.getByText('45 users × 39 resources · 143 cells')).toBeInTheDocument();

    const adjust = screen.getByRole('button', { name: 'Adjust matrix' });
    expect(adjust).toHaveTextContent(/^Adjust$/);
    await userEvent.setup().click(adjust);
    expect(onAdjust).toHaveBeenCalledTimes(1);
    // No options: not a step, not a fresh matrix — and not the click event either.
    expect(onAdjust.mock.calls[0]).toEqual([]);
  });

  it('counts identities for an identity matrix', () => {
    renderSummary({ ...seededFilter, rowType: 'identity' });
    expect(screen.getByText('45 identities × 39 resources · 143 cells')).toBeInTheDocument();
  });

  it('shows no counts before they are known', () => {
    renderSummary(seededFilter, { counts: null });
    expect(screen.queryByText(/resources ·/)).not.toBeInTheDocument();
  });

  it('holds the name, the counts and Adjust in ONE row, without the old Load / Save / Share controls or scope chips', async () => {
    renderSummary(adjustedFilter);
    const row = screen.getByRole('button', { name: 'Adjust matrix' }).parentElement;
    expect(row).toContainElement(await screen.findByRole('button', { name: 'Fortigi Demo Corp — All' }));
    expect(row).toContainElement(screen.getByText('45 users × 39 resources · 143 cells'));

    for (const gone of [/Load matrix/, /^Save matrix/, /^Share…$/]) {
      expect(screen.queryByRole('button', { name: gone })).not.toBeInTheDocument();
    }
    for (const chip of ['Rows', 'Subjects', 'Resources', 'Cells', 'User × Resource']) {
      expect(screen.queryByText(chip)).not.toBeInTheDocument();
    }
  });

  it('keeps the saved name after an adjust that changed nothing', async () => {
    // The applied filter is the normalised shape of the stored one. Comparing
    // raw JSON relabelled it unsaved the moment the analyst opened the wizard
    // and applied without touching a control.
    renderSummary({ ...adjustedFilter, savedFilterId: 'sf-1' });
    expect(await screen.findByRole('button', { name: 'Fortigi Demo Corp — All' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });

  it('keeps that name while the analyst folds and drills the matrix', async () => {
    renderSummary({
      ...adjustedFilter,
      savedFilterId: 'sf-1',
      rollupExpanded: ['node-1'],
      rollupCollapsed: ['0|8:Everyone'],
      rollupPath: ['node-1'],
      foldAttributes: true,
    });
    expect(await screen.findByRole('button', { name: 'Fortigi Demo Corp — All' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });

  it('opens the wizard on its save step from "Unsaved changes" once a real field changed', async () => {
    const { onAdjust } = renderSummary({ ...adjustedFilter, rowType: 'identity', savedFilterId: 'sf-1' });
    expect(await screen.findByRole('button', { name: 'Fortigi Demo Corp — All' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Unsaved changes' }));
    expect(onAdjust).toHaveBeenCalledWith({ step: 'share' });
  });

  it('falls back to "Unsaved matrix" when the saved-matrix list cannot be loaded', async () => {
    const authFetch = makeAuthFetch(() => jsonResponse({ error: 'nope' }, { ok: false, status: 500 }));
    renderSummary({ ...adjustedFilter, savedFilterId: 'sf-1' }, { authFetch });
    expect(await screen.findByRole('button', { name: 'Unsaved matrix' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });
});
