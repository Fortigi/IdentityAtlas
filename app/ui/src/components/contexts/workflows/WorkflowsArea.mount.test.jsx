// @vitest-environment jsdom
// The Actions area per kind of unit: which cards it shows and what the matrix
// link opens. The entitlement report is on applications only.
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import WorkflowsArea from './WorkflowsArea';
import { renderWithProviders, makeAuthFetch, screen } from '@ui/test-utils/renderWithProviders';
import { SharedViewContext } from '@ui/contexts/SharedViewContext';

const APP = { id: 'c-app', displayName: 'SAP', contextCategory: 'LogicalApplication', targetType: 'Resource' };
const RES_UNIT = { id: 'c-res', displayName: 'Finance shares', contextCategory: 'OrganizationalUnit', targetType: 'Resource' };
const ACC_UNIT = { id: 'c-acc', displayName: 'Finance accounts', contextCategory: 'OrganizationalUnit', targetType: 'Principal' };
const PPL_UNIT = { id: 'c-ppl', displayName: 'Finance', contextCategory: 'OrganizationalUnit', targetType: 'Identity' };
const PPL_SELF = { id: 'c-ppl', displayName: 'Finance', targetType: 'Identity', self: true };
const ACC_VARIANT = { id: 'c-acc', displayName: 'Finance accounts', targetType: 'Principal', self: false };

function mount(attrs, { variants = [], sharedView = false } = {}) {
  const area = h(WorkflowsArea, { attrs, variants, variantsLoading: false, onOpenDetail: vi.fn() });
  renderWithProviders(h(SharedViewContext.Provider, { value: sharedView }, area), { auth: { authFetch: makeAuthFetch() } });
}

// The filter a matrix link carries, read back the way App.jsx reads it.
function matrixFilterOf(link) {
  const raw = decodeURIComponent(link.getAttribute('href'));
  expect(raw.startsWith('#matrix?')).toBe(true);
  return JSON.parse(new URLSearchParams(raw.slice(raw.indexOf('?') + 1)).get('filter'));
}

const cond = id => ({ kind: 'context', contextId: id, includeChildren: true });
const reportCard = () => screen.queryByTestId('action-download-report');
const unitReportCard = () => screen.queryByTestId('action-download-unit-report');
const matrixLink = () => screen.getByRole('link', { name: 'View in matrix ↗' });

describe('WorkflowsArea (Actions)', () => {
  it('is headed Actions, never Workflows', () => {
    mount(APP);
    expect(screen.getByRole('region', { name: 'Actions' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Actions' })).toBeInTheDocument();
    expect(screen.queryByText(/workflow|variant/i)).toBeNull();
  });

  it('an application opens the matrix with its resources as columns and offers the entitlement report', () => {
    mount(APP);
    const link = matrixLink();
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('title', 'opens in a new tab');
    const filter = matrixFilterOf(link);
    expect(filter.orientation).toBe('rows-as-subjects');
    expect(filter.resource.include).toEqual([cond('c-app')]);
    expect(filter.subject.include).toEqual([]);
    expect(screen.getByText(/Its resources as columns/)).toBeInTheDocument();
    expect(reportCard()).toBeInTheDocument();
  });

  it('a resource unit opens the matrix on its resources, with no report of either kind', () => {
    mount(RES_UNIT);
    const filter = matrixFilterOf(matrixLink());
    expect(filter.resource.include).toEqual([cond('c-res')]);
    expect(reportCard()).toBeNull();
    expect(unitReportCard()).toBeNull();
  });

  it('a unit of accounts opens the matrix on its members and offers the unit report, not the entitlement report', () => {
    mount(ACC_UNIT);
    const filter = matrixFilterOf(matrixLink());
    expect(filter.subject.include).toEqual([cond('c-acc')]);
    expect(filter.resource.include).toEqual([]);
    expect(filter.rowType).toBe('principal');
    expect(screen.getByText(/The members of this unit as rows/)).toBeInTheDocument();
    expect(reportCard()).toBeNull();
    expect(unitReportCard()).toHaveTextContent('Download unit report');
  });

  it('a unit of people opens the matrix on its people and offers the unit report', () => {
    mount(PPL_UNIT, { variants: [PPL_SELF, ACC_VARIANT] });
    const filter = matrixFilterOf(matrixLink());
    expect(filter.rowType).toBe('identity');
    expect(filter.subject.include).toEqual([cond('c-ppl')]);
    expect(reportCard()).toBeNull();
    expect(unitReportCard()).toBeInTheDocument();
    expect(screen.queryByText(/Reports are available/)).toBeNull();
  });

  it('renders nothing for a template without actions', () => {
    mount({ ...ACC_UNIT, contextCategory: 'Tag' });
    expect(screen.queryByRole('region', { name: 'Actions' })).toBeNull();
  });

  it('offers no announced-but-unbuilt actions', () => {
    mount(APP);
    expect(screen.queryByText('Coming soon')).toBeNull();
    mount(PPL_UNIT);
    expect(screen.queryAllByText('Coming soon')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Start (survey|review)/ })).toBeNull();
  });

  it('keeps the unit report on the read-only page of the unit owner', () => {
    mount(ACC_UNIT, { sharedView: true });
    expect(unitReportCard()).toBeInTheDocument();
  });

  it('keeps the entitlement report on a read-only shared view of an application', () => {
    mount(APP, { sharedView: true });
    expect(reportCard()).toBeInTheDocument();
  });
});
