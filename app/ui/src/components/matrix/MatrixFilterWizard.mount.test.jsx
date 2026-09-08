// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h, useState } from 'react';
import MatrixFilterWizard from './MatrixFilterWizard';
import {
  renderWithProviders, makeAuthFetch, jsonResponse,
  screen, fireEvent, waitFor, userEvent,
} from '@ui/test-utils/renderWithProviders';

// Column schema payloads returned by /api/matrix/columns. Each row is a
// { column, values } pair; the wizard's Sort step and AttributePicker read
// `.column` / `.values`.
const principalCols = [
  { column: 'displayName', values: [] },
  { column: 'department', values: ['Engineering', 'Sales'] },
  { column: 'jobTitle', values: ['Manager', 'Analyst'] },
  { column: 'city', values: ['London', 'Berlin'] },
];
const resourceCols = [
  { column: 'displayName', values: [] },
  { column: 'resourceType', values: ['Group', 'Application'] },
];
const identityCols = [
  { column: 'displayName', values: [] },
  { column: 'company', values: ['Acme', 'Globex'] },
];

const previewBody = {
  subjectCount: 120, subjectTotal: 200,
  resourceCount: 30, resourceTotal: 50,
  assignmentCount: 1500,
};

// Build an authFetch that serves the wizard's discovery endpoints. The columns
// endpoint discriminates on the entity query param; preview is a POST.
function makeFetch(extra = {}) {
  return makeAuthFetch((url, opts = {}) => {
    const u = String(url);
    if (u.includes('/api/matrix/saved-filters') && opts.method === 'POST') {
      return jsonResponse({ id: 'sf-new', name: 'My Matrix', filter: {} });
    }
    if (u.includes('/api/matrix/saved-filters')) {
      return jsonResponse([
        { id: 'sf-1', name: 'HR users', filter: { rowType: 'principal', subject: { include: [{ kind: 'attribute', field: 'department', values: ['HR'] }], exclude: [] } } },
      ]);
    }
    if (u.includes('/api/matrix/columns')) {
      if (u.includes('entity=Identity')) return jsonResponse(identityCols);
      if (u.includes('entity=Resource')) return jsonResponse(resourceCols);
      return jsonResponse(principalCols);
    }
    if (u.includes('/api/matrix/preview')) {
      return jsonResponse({ ...previewBody, ...(extra.preview || {}) });
    }
    if (u.includes('/api/contexts?contextType=ManagerHierarchy')) {
      return jsonResponse({ data: [{ id: 'ctx-1', displayName: 'Org Chart', totalMemberCount: 99 }] });
    }
    return undefined; // 404
  });
}

function renderWizard(props = {}, authFetch = makeFetch()) {
  const onApply = props.onApply || vi.fn();
  const onClose = props.onClose || vi.fn();
  const result = renderWithProviders(
    h(MatrixFilterWizard, {
      open: props.open ?? true,
      initialFilter: props.initialFilter,
      initialManaged: props.initialManaged,
      onApply,
      onClose,
    }),
    { auth: { authFetch } },
  );
  return { ...result, onApply, onClose, authFetch };
}

describe('MatrixFilterWizard (mounted)', () => {
  it('renders nothing when closed', () => {
    const { container } = renderWizard({ open: false });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the Setup step with the subject-type choices', async () => {
    renderWizard();
    expect(screen.getByText('Create matrix')).toBeInTheDocument();
    expect(screen.getByText('User accounts')).toBeInTheDocument();
    expect(screen.getByText('Identities')).toBeInTheDocument();
    // The live preview fires on mount (debounced) and renders counts.
    expect(await screen.findByText('120')).toBeInTheDocument();
    expect(screen.getByText(/of 200/)).toBeInTheDocument();
  });

  it('shows "Adjust matrix" and loads identity columns when initialFilter targets identities', async () => {
    const { authFetch } = renderWizard({
      initialFilter: {
        rowType: 'identity',
        orientation: 'rows-as-resources',
        subject: { include: [], exclude: [] },
        resource: { include: [], exclude: [] },
        sortAttributes: [{ attribute: 'company', dir: 'asc' }],
      },
    });
    expect(screen.getByText('Adjust matrix')).toBeInTheDocument();
    await waitFor(() => {
      expect(authFetch).toHaveBeenCalledWith(
        expect.stringContaining('entity=Identity'),
      );
    });
  });

  it('keeps the full column values when the schema-only fast paint answers last', async () => {
    // The wizard asks for each entity's columns twice at once — `?schema=true`
    // for an instant field list, and the full request that carries the values
    // (and, from them, the ext.* extension attributes). Neither ordering is
    // guaranteed. If the fast answer is allowed to land second it wipes the real
    // one out, and the wizard settles into offering every field with a "(0)"
    // count and no extension attributes — indistinguishable on screen from a
    // deployment that genuinely has no values to filter on.
    let releaseSchema;
    const schemaLanded = new Promise(resolve => { releaseSchema = resolve; });
    const schemaOnly = cols => cols.map(({ column }) => ({ column, values: [] }));

    const authFetch = makeAuthFetch(async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/api/matrix/columns') && u.includes('schema=true')) {
        await schemaLanded;
        return schemaOnly(u.includes('entity=Resource') ? resourceCols : principalCols);
      }
      return makeFetch()(u, opts);
    });

    renderWizard({}, authFetch);
    const user = userEvent.setup();

    // Subjects step → open the attribute picker. The full response has landed,
    // so `department` offers its two values.
    await user.click(screen.getByText('Next'));
    await user.click(await screen.findByText('+ Attribute'));
    expect(await screen.findByRole('option', { name: 'department (2)' })).toBeInTheDocument();

    // Now let the slow fast-paint arrive. It must not be able to take those
    // values away again.
    releaseSchema();
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining('schema=true'),
    ));
    await expect(screen.findByRole('option', { name: 'department (0)' })).rejects.toThrow();
    expect(screen.getByRole('option', { name: 'department (2)' })).toBeInTheDocument();
  });

  it('steps through Setup → Subjects → Resources → Sort and back', async () => {
    renderWizard();
    const user = userEvent.setup();

    // Switch subject type to Identities (exercises setRowType + lazy load).
    await user.click(screen.getByText('Identities'));

    // Next → Subjects.
    await user.click(screen.getByText('Next'));
    expect(await screen.findByText(/appear as rows/i)).toBeInTheDocument();

    // Next → Resources.
    await user.click(screen.getByText('Next'));
    expect(await screen.findByText(/appear as columns/i)).toBeInTheDocument();
    expect(screen.getByText('Include inherited access')).toBeInTheDocument();

    // Next → Sort.
    await user.click(screen.getByText('Next'));
    expect(await screen.findByText('Sort columns')).toBeInTheDocument();

    // Back → Resources.
    await user.click(screen.getByText('Back'));
    expect(await screen.findByText(/appear as columns/i)).toBeInTheDocument();
  });

  it('adjusts a partial filter (no sortAttributes) all the way to the Sort step', async () => {
    // A matrix filter can arrive from a shared URL, an older saved matrix, or
    // the seeded org default — none of which is guaranteed to carry every
    // field. Adjusting one used to crash the page on the Sort step
    // ("Cannot read properties of undefined (reading 'length')"); the wizard
    // now normalises whatever it is handed.
    const { onApply } = renderWizard({
      initialFilter: {
        rowType: 'principal',
        orientation: 'rows-as-resources',
        subject: { include: [], exclude: [] },
        resource: { include: [], exclude: [] },
      },
    });
    const user = userEvent.setup();

    expect(screen.getByText('Adjust matrix')).toBeInTheDocument();
    await user.click(screen.getByText('Next')); // → Subjects
    await user.click(screen.getByText('Next')); // → Resources
    await user.click(screen.getByText('Next')); // → Sort
    expect(await screen.findByText('Sort columns')).toBeInTheDocument();
    // Falls back to the default sort attribute rather than rendering empty.
    expect(screen.getByText('Sort by')).toBeInTheDocument();

    await user.click(screen.getByText('Apply'));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ sortAttributes: [{ attribute: 'department', dir: 'asc' }] }),
      'all',
    );
  });

  it('adjusts a filter with no subject/resource blocks at all', async () => {
    // Same class of input, one step earlier: the Subjects/Resources steps read
    // filter.subject.include / filter.resource.include directly.
    renderWizard({ initialFilter: { rowType: 'principal' } });
    const user = userEvent.setup();

    await user.click(screen.getByText('Next')); // → Subjects
    expect(await screen.findByText(/appear as rows/i)).toBeInTheDocument();
    await user.click(screen.getByText('Next')); // → Resources
    expect(await screen.findByText(/appear as columns/i)).toBeInTheDocument();
  });

  it('resets back to the Setup step when reopened after navigating away', async () => {
    // A stateful harness toggles `open` so the closed→open reset (now done
    // during render rather than in an effect) runs through React normally.
    function Harness() {
      const [open, setOpen] = useState(true);
      return h('div', null,
        h('button', { onClick: () => setOpen((o) => !o) }, 'toggle'),
        h(MatrixFilterWizard, { open, onApply: vi.fn(), onClose: () => setOpen(false) }),
      );
    }
    renderWithProviders(h(Harness), { auth: { authFetch: makeFetch() } });
    const user = userEvent.setup();

    // Advance from Setup → Subjects.
    await screen.findByText('User accounts');
    await user.click(screen.getByText('Next'));
    expect(await screen.findByText(/appear as rows/i)).toBeInTheDocument();

    // Close then reopen — the wizard must be back on the Setup step.
    await user.click(screen.getByText('toggle')); // close
    await user.click(screen.getByText('toggle')); // reopen
    expect(await screen.findByText('Create matrix')).toBeInTheDocument();
    expect(screen.getByText('User accounts')).toBeInTheDocument();
    expect(screen.queryByText(/appear as rows/i)).not.toBeInTheDocument();
  });

  it('toggles the "Include inherited access" checkbox on the Resources step', async () => {
    renderWizard();
    const user = userEvent.setup();
    await user.click(screen.getByText('Next')); // subjects
    await user.click(screen.getByText('Next')); // resources

    const checkbox = screen.getByRole('checkbox', { name: /Include inherited access/i });
    expect(checkbox).not.toBeChecked();
    await user.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  it('adds an attribute condition through the AttributePicker and shows it as a chip', async () => {
    renderWizard();
    const user = userEvent.setup();
    await user.click(screen.getByText('Next')); // → Subjects

    // Open the "+ Attribute" picker on the Include list (first one).
    const attrButtons = screen.getAllByText('+ Attribute');
    await user.click(attrButtons[0]);

    expect(await screen.findByText('Add attribute filter')).toBeInTheDocument();

    // Pick the department field, then select a value.
    const fieldSelect = screen.getByRole('combobox');
    fireEvent.change(fieldSelect, { target: { value: 'department' } });
    const engCheckbox = await screen.findByRole('checkbox', { name: /Engineering/i });
    await user.click(engCheckbox);

    // Add commits the condition.
    await user.click(screen.getByText('Add'));

    // The chip renders with field + value.
    expect(await screen.findByText('Engineering')).toBeInTheDocument();
  });

  it('steps through the Sort step: adds an attribute and toggles direction', async () => {
    renderWizard();
    const user = userEvent.setup();
    await user.click(screen.getByText('Next')); // subjects
    await user.click(screen.getByText('Next')); // resources
    await user.click(screen.getByText('Next')); // sort

    expect(await screen.findByText('Sort columns')).toBeInTheDocument();

    // Toggle the first row's direction (A→Z default).
    const dirBtn = screen.getByTitle(/Toggle ascending/i);
    await user.click(dirBtn);

    // Add a second sort attribute.
    await user.click(screen.getByText('+ Add attribute'));
    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBeGreaterThan(1);
  });

  it('switches the Sort step to Manager Hierarchy and loads the hierarchy list', async () => {
    renderWizard();
    const user = userEvent.setup();
    await user.click(screen.getByText('Next')); // subjects
    await user.click(screen.getByText('Next')); // resources
    await user.click(screen.getByText('Next')); // sort

    await user.click(await screen.findByText('By Manager Hierarchy'));

    // The hierarchy <select> populates from /api/contexts?contextType=ManagerHierarchy.
    expect(await screen.findByText(/Org Chart \(99\)/)).toBeInTheDocument();
  });

  it('calls onApply with the filter and managed state when Apply is clicked', async () => {
    const { onApply } = renderWizard({ initialManaged: 'managed' });
    const user = userEvent.setup();
    await user.click(screen.getByText('Next')); // subjects
    await user.click(screen.getByText('Next')); // resources
    await user.click(screen.getByText('Next')); // sort

    await user.click(await screen.findByText('Apply'));
    expect(onApply).toHaveBeenCalledTimes(1);
    const [appliedFilter, managed] = onApply.mock.calls[0];
    expect(appliedFilter).toMatchObject({ rowType: 'principal' });
    expect(managed).toBe('managed');
  });

  it('calls onClose when Cancel is clicked', async () => {
    const { onClose } = renderWizard();
    const user = userEvent.setup();
    await user.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('does not apply or close when Cancel is clicked', async () => {
    // Cancel must discard, not commit. Covers the other half of the Cancel handler: onApply is
    // what triggers the parent's data fetch, so a Cancel that also applied would silently run
    // the query the user just backed out of.
    const { onApply, onClose } = renderWizard();
    const user = userEvent.setup();
    await user.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('loads a saved matrix from the dropdown and jumps to the Subjects step', async () => {
    renderWizard();
    const user = userEvent.setup();

    // Open the saved-matrices dropdown (label shows the count).
    await user.click(await screen.findByText(/Saved matrices \(1\)/));
    await user.click(await screen.findByText('HR users'));

    // Loading a saved matrix lands on the Subjects step and the HR chip renders.
    expect(await screen.findByText(/appear as rows/i)).toBeInTheDocument();
    expect(await screen.findByText('HR')).toBeInTheDocument();
  });

  it('opens the Save dialog once a condition exists and saves it', async () => {
    const { authFetch } = renderWizard();
    const user = userEvent.setup();

    // Add a condition so "Save matrix…" becomes enabled.
    await user.click(screen.getByText('Next')); // subjects
    await user.click(screen.getAllByText('+ Attribute')[0]);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'department' } });
    await user.click(await screen.findByRole('checkbox', { name: /Engineering/i }));
    await user.click(screen.getByText('Add'));

    // Open the Save dialog.
    await user.click(screen.getByText(/Save matrix…/));
    expect(await screen.findByText('Save matrix')).toBeInTheDocument();

    const nameInput = screen.getByPlaceholderText(/HR users/i);
    fireEvent.change(nameInput, { target: { value: 'My Matrix' } });
    await user.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(authFetch).toHaveBeenCalledWith(
        '/api/matrix/saved-filters',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('blocks Apply and shows an error for an oversized flat unfoldable matrix', async () => {
    const { onApply } = renderWizard(
      {
        initialFilter: {
          rowType: 'principal',
          orientation: 'rows-as-resources',
          subject: { include: [], exclude: [] },
          resource: { include: [], exclude: [] },
          sortAttributes: [],            // no sort attributes → can't fold → blocked
          foldOnLoad: false,
        },
      },
      makeFetch({ preview: { assignmentCount: 99999 } }),
    );
    const user = userEvent.setup();
    await user.click(screen.getByText('Next')); // subjects
    await user.click(screen.getByText('Next')); // resources

    // No Sort step when sortAttributes is empty? Sort step still shows; advance.
    const next = screen.queryByText('Next');
    if (next) await user.click(next);

    // Wait for the oversized preview to land, then Apply should be disabled.
    // Locale-agnostic: the count is rendered via toLocaleString() (en-US "99,999"
    // vs en-NL "99.999"), so match the same formatting, escaped for the regex.
    const count = (99999).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(await screen.findByText(new RegExp(count))).toBeInTheDocument();
    const applyBtn = await screen.findByText('Apply');
    expect(applyBtn).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();
  });
});
