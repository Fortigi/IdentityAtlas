// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, fireEvent } from '@ui/test-utils/renderWithProviders';
import ListReportRenderer, { ROWS_PER_PAGE } from '@ui/components/reports/ListReportRenderer';

// One row per index, so an assertion can name the row it expects to see.
const manyRows = (n) => Array.from({ length: n }, (_, i) => ({
  displayName: `Row ${i}`, email: `r${i}@example.com`,
}));

const report = (over = {}) => ({
  displayName: 'Orphaned Accounts',
  columns: [{ key: 'displayName', label: 'Account' }, { key: 'email', label: 'Email' }],
  rows: [{ displayName: 'Ada Lovelace', email: 'ada@example.com', _entity: { kind: 'user', id: 'p1' } }],
  ...over,
});

describe('ListReportRenderer', () => {
  it('builds the table from the columns the report declared', () => {
    // Column headings and cell values both come from the response — the
    // renderer has no per-report knowledge of either.
    renderWithProviders(<ListReportRenderer report={report()} />);

    expect(screen.getByRole('columnheader', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Email' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'ada@example.com' })).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(2); // header + one data row
  });

  it('renders an unfamiliar column set just as happily', () => {
    renderWithProviders(<ListReportRenderer report={report({
      columns: [{ key: 'thing', label: 'Thing' }, { key: 'count', label: 'Count' }],
      rows: [{ thing: 'widget', count: 3 }],
    })} />);

    expect(screen.getByRole('columnheader', { name: 'Thing' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '3' })).toBeInTheDocument();
  });

  it('opens the linked entity detail when the row is clicked', () => {
    const onOpenDetail = vi.fn();
    renderWithProviders(<ListReportRenderer report={report()} onOpenDetail={onOpenDetail} />);

    // Only the first cell is the link — the rest of the row stays plain text.
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Ada Lovelace' }));
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'p1', 'Ada Lovelace');
    expect(screen.getByRole('cell', { name: 'ada@example.com' }).querySelector('button')).toBeNull();
  });

  it('renders a row with no entity as plain text, not a dead link', () => {
    renderWithProviders(<ListReportRenderer report={report({
      rows: [{ displayName: 'No Link', email: 'x@example.com' }],
    })} onOpenDetail={() => {}} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'No Link' })).toBeInTheDocument();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ])('renders %s as a dash, never as the raw value', (_label, value) => {
    renderWithProviders(<ListReportRenderer report={report({
      rows: [{ displayName: 'Sparse', email: value, _entity: { kind: 'user', id: 'p9' } }],
    })} onOpenDetail={() => {}} />);

    const row = screen.getByRole('button', { name: 'Sparse' }).closest('tr');
    expect(row).toHaveTextContent('—');
    expect(row?.textContent).not.toMatch(/null|undefined/);
  });

  it('renders a zero as a zero, not as a dash', () => {
    // The blank check must test for null/undefined/'' specifically — a falsy but
    // real value is data, and blanking it would silently misreport a count.
    renderWithProviders(<ListReportRenderer report={report({
      columns: [{ key: 'thing', label: 'Thing' }, { key: 'count', label: 'Count' }],
      rows: [{ thing: 'widget', count: 0 }],
    })} />);

    expect(screen.getByRole('cell', { name: '0' })).toBeInTheDocument();
  });

  it('renders a row with no entity and no first-column value', () => {
    renderWithProviders(<ListReportRenderer report={report({
      rows: [{ displayName: null, email: 'orphan@example.com' }],
    })} onOpenDetail={() => {}} />);

    expect(screen.getByRole('cell', { name: 'orphan@example.com' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows an empty state instead of a headerless table when there are no rows', () => {
    renderWithProviders(<ListReportRenderer report={report({ rows: [] })} />);

    expect(screen.getByText('No rows')).toBeInTheDocument();
    expect(screen.getByText(/Orphaned Accounts found nothing/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('tolerates a response with neither columns nor rows', () => {
    renderWithProviders(<ListReportRenderer report={{ displayName: 'Empty Report' }} />);
    expect(screen.getByText('No rows')).toBeInTheDocument();
  });

  it('renders rows even when the response declares no columns', () => {
    // Degenerate but reachable: rows without column metadata produce an empty
    // table rather than a crash.
    renderWithProviders(<ListReportRenderer
      report={{ displayName: 'Columnless', rows: [{ a: 1, _entity: { kind: 'user', id: 'p7' } }] }}
      onOpenDetail={() => {}}
    />);

    expect(screen.queryAllByRole('columnheader')).toHaveLength(0);
    expect(screen.queryAllByRole('cell')).toHaveLength(0);
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('draws one page of rows, not the whole result set', () => {
    // The API returns every row in one response; drawing 39,000 of them is what
    // locks the browser up. The count is what discriminates: a renderer that
    // paged the pager but not the table would still show all the rows.
    renderWithProviders(<ListReportRenderer report={report({ rows: manyRows(250) })} />);

    expect(screen.getAllByRole('row')).toHaveLength(ROWS_PER_PAGE + 1); // header + page
    expect(screen.getByRole('cell', { name: 'Row 0' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: `Row ${ROWS_PER_PAGE}` })).not.toBeInTheDocument();
    expect(screen.getByText('Showing 1–100 of 250')).toBeInTheDocument();
  });

  it('moves to the next page and back', () => {
    renderWithProviders(<ListReportRenderer report={report({ rows: manyRows(250) })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('cell', { name: `Row ${ROWS_PER_PAGE}` })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'Row 0' })).not.toBeInTheDocument();
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Prev' }));
    expect(screen.getByRole('cell', { name: 'Row 0' })).toBeInTheDocument();
  });

  it('shows the last, short page in full', () => {
    renderWithProviders(<ListReportRenderer report={report({ rows: manyRows(250) })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getAllByRole('row')).toHaveLength(51); // header + the remaining 50
    expect(screen.getByText('Showing 201–250 of 250')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('draws no pager at all when everything fits on one page', () => {
    renderWithProviders(<ListReportRenderer report={report({ rows: manyRows(ROWS_PER_PAGE) })} />);

    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(ROWS_PER_PAGE + 1);
  });

  it('returns to the first page when the report is re-run', () => {
    // Refresh and a parameter change both replace the rows. Staying on page 3
    // of a result that now has one page shows an empty table.
    const { rerender } = renderWithProviders(
      <ListReportRenderer report={report({ name: 'r', generatedAt: 't1', rows: manyRows(250) })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();

    rerender(<ListReportRenderer report={report({ name: 'r', generatedAt: 't2', rows: manyRows(250) })} />);
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Row 0' })).toBeInTheDocument();
  });
});
