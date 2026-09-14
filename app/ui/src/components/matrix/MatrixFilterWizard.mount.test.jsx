// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h, useState } from 'react';
import MatrixFilterWizard from './MatrixFilterWizard';
import {
  renderWithProviders, makeAuthFetch, jsonResponse,
  screen, within, fireEvent, waitFor, userEvent,
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

// Matrix sharing on by default, so the default (wildcard) user gets the full
// step list including Share; the Share-step block below turns it off.
function renderWizard(props = {}, authFetch = makeFetch(), features = { matrixSharing: true }) {
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
    { auth: { authFetch }, features },
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
    await user.click((await screen.findAllByText('+ Attribute'))[0]); // Include list
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

    // Sharing is the last step for a user who may share (#1166), so Apply now
    // lives one step further on.
    await user.click(screen.getByText('Next')); // → Share
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
    renderWithProviders(h(Harness), { auth: { authFetch: makeFetch() }, features: { matrixSharing: true } });
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

  it('starts with business-role rows off and applies the flag once ticked', async () => {
    // Business roles are already the SOLL columns, so they are off the row axis
    // by default (#937). The checkbox is the matrix-level opt-in, so what
    // matters is that it reaches onApply — that value is what gets POSTed and
    // saved with the matrix.
    const { onApply } = renderWizard();
    const user = userEvent.setup();
    await user.click(screen.getByText('Next')); // subjects
    await user.click(screen.getByText('Next')); // resources

    const checkbox = screen.getByRole('checkbox', { name: /Show business roles as foldable rows/i });
    expect(checkbox).not.toBeChecked();
    await user.click(checkbox);
    expect(checkbox).toBeChecked();
    // Ticking one option must not tick the other — they share a component.
    expect(screen.getByRole('checkbox', { name: /Include inherited access/i })).not.toBeChecked();

    await user.click(screen.getByText('Next')); // sort
    // Sharing is the last step for a user who may share (#1166), so Apply lives there.
    await user.click(screen.getByText('Next')); // → Share
    await user.click(await screen.findByText('Apply'));
    expect(onApply.mock.calls[0][0]).toMatchObject({ includeBusinessRoles: true });
  });

  it('shows the box already ticked when adjusting a matrix that opted in', async () => {
    renderWizard({ initialFilter: { rowType: 'principal', includeBusinessRoles: true } });
    const user = userEvent.setup();
    await user.click(screen.getByText('Next')); // subjects
    await user.click(screen.getByText('Next')); // resources
    expect(screen.getByRole('checkbox', { name: /Show business roles as foldable rows/i })).toBeChecked();
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

  // #1202: trends & breakdown is opt-in per matrix, and the Sort step is where
  // it is switched on. Both halves matter — that Apply carries `true` after the
  // tick, and that it carries `false` without one (the panel used to be
  // unconditional, so only the pair pins the default).
  it('ticks trends & breakdown on the Sort step and applies it with the matrix', async () => {
    const { onApply } = renderWizard();
    const user = userEvent.setup();
    await user.click(screen.getByText('Next')); // subjects
    await user.click(screen.getByText('Next')); // resources
    await user.click(screen.getByText('Next')); // sort

    const box = await screen.findByRole('checkbox', { name: /Show trends & breakdown above the matrix/ });
    expect(box).not.toBeChecked();
    await user.click(box);
    expect(box).toBeChecked();

    await user.click(screen.getByText('Next')); // share
    await user.click(await screen.findByText('Apply'));
    expect(onApply.mock.calls[0][0]).toMatchObject({ showTrends: true });
  });

  it('applies a matrix without the trends panel when the box is left alone', async () => {
    const { onApply } = renderWizard();
    const user = userEvent.setup();
    for (const _ of [1, 2, 3, 4]) await user.click(screen.getByText('Next')); // → share
    await user.click(await screen.findByText('Apply'));
    expect(onApply.mock.calls[0][0]).toMatchObject({ showTrends: false });
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
    await user.click(screen.getByText('Next')); // share (#1166)

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
    expect(await screen.findByRole('heading', { name: 'Save matrix' })).toBeInTheDocument();

    const nameInput = screen.getByRole('textbox', { name: 'Matrix name' });
    fireEvent.change(nameInput, { target: { value: 'My Matrix' } });
    await user.click(screen.getByRole('button', { name: 'Save as new matrix' }));

    await waitFor(() => {
      expect(authFetch).toHaveBeenCalledWith(
        '/api/matrix/saved-filters',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('saving a change back to the matrix being edited (#1202)', () => {
    const hrFilter = {
      rowType: 'principal',
      subject: { include: [{ kind: 'attribute', field: 'department', values: ['HR'] }], exclude: [] },
    };

    // The org's saved list holds one SHARED matrix the wizard was opened on;
    // PUT answers with `putResponse`.
    function editFetch(putResponse) {
      return makeAuthFetch((url, opts = {}) => {
        const u = String(url);
        if (u.includes('/api/matrix/saved-filters/sf-1') && opts.method === 'PUT') return putResponse;
        if (u.includes('/api/matrix/saved-filters')) {
          return jsonResponse([{ id: 'sf-1', name: 'HR users', filter: hrFilter, shared: true, recipientCount: 2 }]);
        }
        if (u.includes('/api/matrix/columns')) return jsonResponse(u.includes('entity=Resource') ? resourceCols : principalCols);
        if (u.includes('/api/matrix/preview')) return jsonResponse(previewBody);
        return undefined;
      });
    }

    // Open on the saved matrix, then diverge from it by adding a condition.
    async function divergeAndOpenSave(authFetch) {
      renderWizard({ initialFilter: hrFilter, initialManaged: 'Governed' }, authFetch);
      const user = userEvent.setup();
      await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/matrix/saved-filters'));
      await user.click(screen.getByText('Next')); // subjects
      await user.click(screen.getAllByText('+ Attribute')[0]);
      fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'jobTitle' } });
      await user.click(await screen.findByRole('checkbox', { name: /Manager/i }));
      await user.click(screen.getByText('Add'));
      await user.click(screen.getByText(/Save matrix…/));
      await screen.findByRole('heading', { name: 'Save matrix' });
      return user;
    }

    it('writes the change to the edited matrix, warning that its recipients will see it', async () => {
      const authFetch = editFetch(jsonResponse({ id: 'sf-1' }));
      const user = await divergeAndOpenSave(authFetch);

      expect(screen.getByText('Shared with 2 people — they will see this change.')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Save changes to HR users' }));

      await waitFor(() => expect(screen.queryByRole('heading', { name: 'Save matrix' })).not.toBeInTheDocument());
      const put = authFetch.mock.calls.find(([u, o]) => u === '/api/matrix/saved-filters/sf-1' && o?.method === 'PUT');
      expect(put).toBeDefined();
      const sent = JSON.parse(put[1].body).filter;
      // Both the original HR condition and the new one travel, with the governed toggle folded in.
      expect(sent.subject.include.map(c => c.field)).toEqual(['department', 'jobTitle']);
      expect(sent.managed).toBe('Governed');
      // No second matrix was created under a new name.
      expect(authFetch.mock.calls.some(([u, o]) => u === '/api/matrix/saved-filters' && o?.method === 'POST')).toBe(false);
      // The list is re-read so the shared state stays current.
      const listReads = authFetch.mock.calls.filter(([u, o]) => u === '/api/matrix/saved-filters' && !o);
      expect(listReads.length).toBeGreaterThanOrEqual(2);
    });

    it('keeps the dialog open and shows the API error when the update is refused', async () => {
      const authFetch = editFetch(jsonResponse({ error: 'Saved matrix not found' }, { ok: false, status: 404 }));
      const user = await divergeAndOpenSave(authFetch);

      await user.click(screen.getByRole('button', { name: 'Save changes to HR users' }));

      expect(await screen.findByText('Saved matrix not found')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Save matrix' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save changes to HR users' })).toBeEnabled();
    });

    // A share made off "HR users" without changing it has identical content.
    // Listed first, so matching on content alone would hand the matrix the
    // wrong identity on Apply.
    async function applyOpenedOn(initialFilter) {
      const authFetch = makeAuthFetch((url) => {
        const u = String(url);
        if (u.includes('/api/matrix/saved-filters')) {
          return jsonResponse([
            { id: 'sf-share', name: 'Sales team', filter: hrFilter, shared: true, recipientCount: 1 },
            { id: 'sf-1', name: 'HR users', filter: hrFilter },
          ]);
        }
        if (u.includes('/api/matrix/columns')) return jsonResponse(u.includes('entity=Resource') ? resourceCols : principalCols);
        if (u.includes('/api/matrix/preview')) return jsonResponse(previewBody);
        return undefined;
      });
      const { onApply } = renderWizard({ initialFilter }, authFetch);
      const user = userEvent.setup();
      await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/matrix/saved-filters'));
      await screen.findByText('120'); // preview landed, so Apply is enabled
      for (let i = 0; i < 6 && !screen.queryByText('Apply'); i++) await user.click(screen.getByText('Next'));
      await user.click(screen.getByText('Apply'));
      return onApply.mock.calls[0][0];
    }

    it('tags the applied matrix with the saved matrix it was opened on, not its twin', async () => {
      expect((await applyOpenedOn({ ...hrFilter, savedFilterId: 'sf-1' })).savedFilterId).toBe('sf-1');
    });

    it('tags an untagged matrix with its first content match', async () => {
      expect((await applyOpenedOn(hrFilter)).savedFilterId).toBe('sf-share');
    });

    it('applies an unsaved matrix without a tag', async () => {
      const applied = await applyOpenedOn({ ...hrFilter, rowType: 'identity', savedFilterId: 'sf-1' });
      expect(applied).not.toHaveProperty('savedFilterId');
    });

    it('falls back to the HTTP status when the refusal carries no message', async () => {
      const authFetch = editFetch({ ok: false, status: 500, json: async () => { throw new Error('not json'); } });
      const user = await divergeAndOpenSave(authFetch);

      await user.click(screen.getByRole('button', { name: 'Save changes to HR users' }));

      expect(await screen.findByText('HTTP 500')).toBeInTheDocument();
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

    // Advance through the remaining steps (Sort, then Share) to reach Apply.
    for (let i = 0; i < 2; i++) {
      const next = screen.queryByText('Next');
      if (next) await user.click(next);
    }

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

describe('MatrixFilterWizard — the Save/Share step (#1166, #1202)', () => {
  const reader = { permissions: new Set(['data.read']), hasWildcard: false, permissionsLoaded: true };

  it('ends on Share for a sharer, with Apply still available there', async () => {
    const { onApply } = renderWizard();
    const user = userEvent.setup();
    await user.click(screen.getByText('Next')); // subjects
    await user.click(screen.getByText('Next')); // resources
    await user.click(screen.getByText('Next')); // sort
    await user.click(screen.getByText('Next')); // share

    // The step offers the save-and-share form…
    expect(await screen.findByText(/Share this matrix \(optional\)/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Name this matrix/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Share with/i })).toBeInTheDocument();
    // …and it is the end of the wizard: Apply, no further Next.
    expect(screen.queryByText('Next')).not.toBeInTheDocument();

    // Skipping the share and applying is the ordinary path.
    await user.click(screen.getByText('Apply'));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  // Two independent reasons the step is missing, one setup each: the install has
  // sharing switched off (a user who COULD share), or the user lacks data.share
  // (sharing switched on). Either alone must leave Sort as the last step.
  it.each([
    ['matrix sharing is switched off, even for a sharer', {}, { matrixSharing: false }],
    ['the user cannot share, even with sharing on', reader, { matrixSharing: true }],
  ])('is absent when %s — Sort stays the last step', async (_why, auth, features) => {
    const onApply = vi.fn();
    renderWithProviders(
      h(MatrixFilterWizard, { open: true, onApply, onClose: vi.fn() }),
      { auth: { ...auth, authFetch: makeFetch() }, features },
    );
    const user = userEvent.setup();
    await user.click(screen.getByText('Next')); // subjects
    await user.click(screen.getByText('Next')); // resources
    await user.click(screen.getByText('Next')); // sort

    expect(await screen.findByText('Sort columns')).toBeInTheDocument();
    expect(screen.queryByText('Next')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Share with/i })).not.toBeInTheDocument();

    await user.click(screen.getByText('Apply'));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  // An oversized matrix that folds on attributes only loads as the layered,
  // server-aggregated view — which Apply arranges by stamping `foldAttributes`.
  // If the step saved-and-shared the raw edit state instead, the recipient would
  // ask for every per-subject row of a matrix that can't be served that way,
  // with no control to fix it.
  const OVERSIZED_FOLDABLE = {
    rowType: 'principal',
    subject: { include: [], exclude: [] },
    resource: { include: [], exclude: [] },
    sortAttributes: [{ attribute: 'department', dir: 'asc' }],
    foldOnLoad: true,
    // Left over from the saved matrix this was loaded from — the committed
    // shape drops it, so the recipient opens at the top level like the sharer.
    rollupExpanded: ['Engineering'],
  };

  function shareFetch() {
    return makeAuthFetch((url, opts = {}) => {
      const u = String(url);
      if (u.includes('/api/matrix/shares') && opts.method === 'POST') {
        return jsonResponse({ id: SHARE_ID, shareAddress: SHARE_ID, recipients: [{ userKey: 'ann@contoso.com', displayName: 'Ann Manager' }] }, { status: 201 });
      }
      if (u.includes('/api/users')) {
        return jsonResponse({ data: [{ id: '3fa85f64-5717-4562-b3fc-2c963f66afa6', displayName: 'Ann Manager', userPrincipalName: 'ann@contoso.com' }] });
      }
      return makeFetch({ preview: { assignmentCount: 99999 } })(url, opts);
    });
  }

  const SHARE_ID = '11111111-1111-1111-1111-111111111111';

  it('shares the matrix Apply would commit, not the raw edit state', async () => {
    const authFetch = shareFetch();
    renderWizard({ initialFilter: OVERSIZED_FOLDABLE }, authFetch);
    const user = userEvent.setup();
    for (const _ of [1, 2, 3]) await user.click(screen.getByText('Next')); // → sort
    await user.click(screen.getByText('Next'));                            // → share

    expect(await screen.findByRole('textbox', { name: /Share with/i })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: /Name this matrix/i }), 'Engineering access');
    await user.type(screen.getByRole('textbox', { name: /Share with/i }), 'ann');
    await user.click(await within(await screen.findByRole('group', { name: 'Search results' }))
      .findByRole('button', { name: /Ann Manager/i }));
    await user.click(screen.getByRole('button', { name: 'Save & share' }));

    await waitFor(() => {
      expect(authFetch).toHaveBeenCalledWith('/api/matrix/shares', expect.objectContaining({ method: 'POST' }));
    });
    const call = authFetch.mock.calls.find(([u, o]) => String(u).includes('/api/matrix/shares') && o?.method === 'POST');
    const body = JSON.parse(call[1].body);
    expect(body.filter.foldAttributes).toBe(true);
    expect(body.filter.rollupExpanded).toEqual([]);
    expect(body.filter.rollupCollapsed).toEqual([]);
    expect(body.recipients).toEqual([
      { principalId: '3fa85f64-5717-4562-b3fc-2c963f66afa6', userKey: 'ann@contoso.com', displayName: 'Ann Manager' },
    ]);
    // The link comes back, addressed by share id, with a copy control next to it.
    expect(await screen.findByText(new RegExp(`#shared:${SHARE_ID}$`))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy share link/i })).toBeInTheDocument();
  });

  it('offers no share form for a matrix too large to load', async () => {
    renderWizard(
      {
        initialFilter: { ...OVERSIZED_FOLDABLE, sortAttributes: [], foldOnLoad: false },
      },
      shareFetch(),
    );
    const user = userEvent.setup();
    for (const _ of [1, 2, 3]) await user.click(screen.getByText('Next')); // → sort
    await user.click(screen.getByText('Next'));                            // → share

    expect(await screen.findByText(/too large to load, so there is nothing to share/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Share with/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save & share' })).not.toBeInTheDocument();
  });
});
