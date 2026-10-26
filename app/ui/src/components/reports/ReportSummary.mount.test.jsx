// @vitest-environment jsdom
//
// The summary a list report draws above its table from the charts and pivots
// it declares — mounted through ListReportRenderer, because the point of the
// summary is that clicking it narrows that table.

import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen, fireEvent, within } from '@ui/test-utils/renderWithProviders';
import ListReportRenderer from '@ui/components/reports/ListReportRenderer';
import { MAX_GROUPS } from '@ui/components/reports/ReportSummary';
import { sliceColor, xlsxKinds } from '@ui/components/reports/summaryData';

const COLUMNS = [
  { key: 'role', label: 'Business role' },
  { key: 'status', label: 'Status' },
  { key: 'system', label: 'System' },
  { key: 'members', label: 'Members' },
];

// Worst first and not alphabetical; member sums differ from row counts.
const ROWS = [
  { role: 'Payroll', status: 'Never reviewed', system: 'Entra', members: 7 },
  { role: 'Finance', status: 'Never reviewed', system: 'Omada', members: 2 },
  { role: 'Audit', status: 'Reviewed', system: 'Entra', members: 40 },
];

const report = (over = {}) => ({
  name: 'access-review-adoption',
  displayName: 'Access Review Adoption',
  generatedAt: 't1',
  columns: COLUMNS,
  rows: ROWS,
  exportFormats: ['csv', 'xlsx', 'json'],
  charts: [
    { name: 'Roles by status', category: 'status', title: 'Business roles by review status', valueLabel: 'Roles',
      colors: { 'Never reviewed': 'DC2626', Reviewed: '16A34A' } },
    { name: 'Members by status', category: 'status', value: 'members', title: 'Role members by review status' },
  ],
  pivots: [
    { name: 'By status', rows: ['status', 'role'], values: ['members'] },
    { name: 'By system', rows: ['system'], values: ['members'] },
  ],
  ...over,
});

const summary = () => screen.getByRole('region', { name: 'Summary' });
const tableRows = () => within(screen.getByRole('table', { name: 'Access Review Adoption' })).getAllByRole('row').slice(1);
// A pivot row's cells as read: the ▸/▾ toggle is decoration, not part of the label.
const pivotCells = table => within(screen.getByRole('table', { name: table })).getAllByRole('row').slice(1)
  .map(r => [...r.cells].map(c => c.textContent.replace(/[▸▾]/g, '')));
const legend = title => within(screen.getByRole('figure', { name: new RegExp(title) }));

describe('ReportSummary', () => {
  it('draws each declared chart with its counts or sums and shares, worst first', () => {
    renderWithProviders(<ListReportRenderer report={report()} />);

    const roles = legend('Business roles by review status').getAllByRole('button');
    expect(roles.map(b => b.textContent)).toEqual(['Never reviewed267%', 'Reviewed133%']);
    const members = legend('Role members by review status').getAllByRole('button');
    // 9 of 49 members — a count instead of a sum would read 2 and 67%.
    expect(members.map(b => b.textContent)).toEqual(['Never reviewed918%', 'Reviewed4082%']);
  });

  it('paints a slice in the colour the report declared', () => {
    renderWithProviders(<ListReportRenderer report={report()} />);
    const swatch = legend('Business roles by review status').getByRole('button', { name: /Reviewed1/ })
      .querySelector('span');
    expect(swatch).toHaveStyle({ backgroundColor: '#16A34A' });
  });

  it('narrows the table to a slice when it is clicked, and back when it is clicked again', () => {
    renderWithProviders(<ListReportRenderer report={report()} />);
    const slice = legend('Business roles by review status').getByRole('button', { name: /^Never reviewed/ });

    fireEvent.click(slice);
    expect(slice).toHaveAttribute('aria-pressed', 'true');
    expect(tableRows().map(r => r.cells[0].textContent)).toEqual(['Payroll', 'Finance']);
    expect(screen.getByRole('status')).toHaveTextContent('Showing 2 of 3 rows where Status is "Never reviewed"');

    fireEvent.click(slice);
    expect(tableRows()).toHaveLength(3);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('brings every row back from the filter bar', () => {
    renderWithProviders(<ListReportRenderer report={report()} />);
    fireEvent.click(legend('Business roles by review status').getByRole('button', { name: /^Reviewed/ }));
    expect(tableRows()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Show all rows' }));
    expect(tableRows()).toHaveLength(3);
  });

  it('shows the first pivot as a grouped table with row counts and sums', () => {
    renderWithProviders(<ListReportRenderer report={report()} />);
    const pivot = within(screen.getByRole('table', { name: 'By status' }));

    expect(pivot.getAllByRole('columnheader').map(h => h.textContent)).toEqual(['Status › Business role', 'Rows', 'Members']);
    expect(pivotCells('By status')).toEqual([['Never reviewed', '2', '9'], ['Reviewed', '1', '40']]);
  });

  it('opens a group to its next level, and closes it again', () => {
    renderWithProviders(<ListReportRenderer report={report()} />);
    const pivot = within(screen.getByRole('table', { name: 'By status' }));

    fireEvent.click(pivot.getByRole('button', { name: 'Expand Never reviewed' }));
    expect(pivotCells('By status').map(cells => cells[0]))
      .toEqual(['Never reviewed', 'Payroll', 'Finance', 'Reviewed']);
    expect(pivot.getByRole('button', { name: 'Collapse Never reviewed' })).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(pivot.getByRole('button', { name: 'Collapse Never reviewed' }));
    expect(pivot.getAllByRole('row')).toHaveLength(3);
  });

  it('narrows the table to a nested group on both of its conditions', () => {
    renderWithProviders(<ListReportRenderer report={report()} />);
    const pivot = within(screen.getByRole('table', { name: 'By status' }));
    fireEvent.click(pivot.getByRole('button', { name: 'Expand Never reviewed' }));
    fireEvent.click(pivot.getByRole('button', { name: 'Finance' }));

    expect(tableRows().map(r => r.cells[0].textContent)).toEqual(['Finance']);
    expect(screen.getByRole('status'))
      .toHaveTextContent('Status is "Never reviewed" and Business role is "Finance"');
  });

  it('switches between the declared pivots', () => {
    renderWithProviders(<ListReportRenderer report={report()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'By system' }));

    const pivot = within(screen.getByRole('table', { name: 'By system' }));
    expect(pivotCells('By system')).toEqual([['Entra', '2', '47'], ['Omada', '1', '2']]);
    // A one-level pivot has nothing to open.
    expect(pivot.queryByRole('button', { name: /^Expand/ })).not.toBeInTheDocument();
  });

  it('draws no tab bar for a single pivot', () => {
    renderWithProviders(<ListReportRenderer report={report({ charts: [], pivots: [report().pivots[1]] })} />);
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'By system' })).toBeInTheDocument();
  });

  it('counts the groups past the limit instead of drawing them', () => {
    const many = Array.from({ length: MAX_GROUPS + 3 }, (_, i) => ({ role: `R${i}`, status: 'x', system: `S${i}`, members: 1 }));
    renderWithProviders(<ListReportRenderer report={report({ rows: many, charts: [], pivots: [{ name: 'By system', rows: ['system'] }] })} />);

    const pivot = within(screen.getByRole('table', { name: 'By system' }));
    expect(pivot.getAllByRole('row')).toHaveLength(1 + MAX_GROUPS + 1);
    expect(pivot.getByText(/and 3 more/)).toBeInTheDocument();
  });

  it('says what the workbook adds, only when the workbook is offered', () => {
    const { unmount } = renderWithProviders(<ListReportRenderer report={report()} />);
    expect(within(summary()).getByText(/XLSX download has these as Excel pivot tables and charts/)).toBeInTheDocument();
    unmount();

    renderWithProviders(<ListReportRenderer report={report({ exportFormats: ['csv'] })} />);
    expect(within(summary()).queryByText(/XLSX/)).not.toBeInTheDocument();
  });

  it('draws nothing for a report that declares no charts or pivots', () => {
    renderWithProviders(<ListReportRenderer report={report({ charts: undefined, pivots: [] })} />);
    expect(screen.queryByRole('region', { name: 'Summary' })).not.toBeInTheDocument();
    expect(tableRows()).toHaveLength(3);
  });

  it('forgets the filter when the report is re-run', () => {
    const { rerender } = renderWithProviders(<ListReportRenderer report={report()} />);
    fireEvent.click(legend('Business roles by review status').getByRole('button', { name: /^Reviewed/ }));
    expect(tableRows()).toHaveLength(1);

    rerender(<ListReportRenderer report={report({ generatedAt: 't2' })} />);
    expect(tableRows()).toHaveLength(3);
  });
});

describe('sliceColor', () => {
  it('uses the declared colour only when it is a six-digit hex', () => {
    const chart = { colors: { a: 'DC2626', b: 'red', c: '#DC2626' } };
    expect(sliceColor(chart, 'a', 0)).toBe('#DC2626');
    expect(sliceColor(chart, 'b', 0)).not.toBe('#red');
    expect(sliceColor(chart, 'b', 1)).toMatch(/^#[0-9a-f]{6}$/i);
    expect(sliceColor(chart, 'c', 2)).not.toBe('##DC2626');
  });

  it('cycles the shared palette by position when there is no declared colour', () => {
    expect(sliceColor({}, 'x', 0)).toBe(sliceColor({}, 'y', 10));
    expect(sliceColor({}, 'x', 0)).not.toBe(sliceColor({}, 'x', 1));
  });
});

describe('xlsxKinds', () => {
  it.each([
    [[1], [1], 'pivot tables and charts'],
    [[1], [], 'pivot tables'],
    [[], [1], 'charts'],
  ])('%j pivots, %j charts → %s', (pivots, charts, expected) => {
    expect(xlsxKinds(pivots, charts)).toBe(expected);
  });
});
