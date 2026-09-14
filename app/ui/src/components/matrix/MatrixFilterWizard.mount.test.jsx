// @vitest-environment jsdom
//
// Mount tests for the Matrix wizard's steps (#1202): Subjects, Resources and
// Layout, the step indicator and the initialStep prop. The Save & share step has
// its own file (MatrixFilterWizard.save.mount.test.jsx).
import { describe, it, expect, vi } from 'vitest';
import { createElement as h, useState } from 'react';
import MatrixFilterWizard from './MatrixFilterWizard';
import {
  renderWithProviders, makeAuthFetch, screen, fireEvent, waitFor, within, userEvent,
} from '@ui/test-utils/renderWithProviders';
import {
  makeWizardFetch, renderWizard, gotoStep, principalCols, resourceCols,
} from '@ui/test-utils/matrixWizardFixtures';

// The real ContextPicker loads a whole context tree; these tests only need "the
// analyst picked this node".
vi.mock('@ui/components/contexts/ContextPicker', () => ({
  default: ({ open, onPick, title }) => (open
    ? h('button', { type: 'button', onClick: () => onPick({ id: 'ctx-picked', displayName: 'Sales tree' }) }, `Pick in: ${title}`)
    : null),
}));

const applied = (onApply) => onApply.mock.calls.at(-1)[0];

// Finish the wizard without saving: jump to the last step and show the matrix.
async function showMatrix(user) {
  await gotoStep(user, 'Save & share');
  await user.click(await screen.findByRole('button', { name: 'Show matrix' }));
}

describe('MatrixFilterWizard (mounted)', () => {
  it('renders nothing when closed', () => {
    const { container } = renderWizard({ open: false });
    expect(container).toBeEmptyDOMElement();
  });

  it('opens on Subjects with the row choice first, and live counts', async () => {
    renderWizard();
    expect(screen.getByText('Create matrix')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^User accounts/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Identities/ })).toHaveAttribute('aria-pressed', 'false');
    // The default matrix puts subjects on the columns — the heading says so.
    expect(screen.getByText('Columns are')).toBeInTheDocument();
    expect(await screen.findByText('120')).toBeInTheDocument();
    expect(screen.getByText(/of 200/)).toBeInTheDocument();
  });

  it('names the axis the other way round for a rotated matrix', () => {
    renderWizard({ initialFilter: { rowType: 'principal', orientation: 'rows-as-subjects' } });
    expect(screen.getByText('Rows are')).toBeInTheDocument();
  });

  it('shows "Adjust matrix" and loads identity columns when initialFilter targets identities', async () => {
    const { authFetch } = renderWizard({
      initialFilter: { rowType: 'identity', sortAttributes: [{ attribute: 'company', dir: 'asc' }] },
    });
    expect(screen.getByText('Adjust matrix')).toBeInTheDocument();
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('entity=Identity')));
  });

  it('keeps the full column values when the schema-only fast paint answers last', async () => {
    // The wizard asks for each entity's columns twice at once — `?schema=true`
    // for an instant field list, and the full request that carries the values.
    // If the fast answer is allowed to land second it wipes the real one out.
    let releaseSchema;
    const schemaLanded = new Promise(resolve => { releaseSchema = resolve; });
    const schemaOnly = cols => cols.map(({ column }) => ({ column, values: [] }));
    const base = makeWizardFetch();
    const authFetch = makeAuthFetch(async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/api/matrix/columns') && u.includes('schema=true')) {
        await schemaLanded;
        return schemaOnly(u.includes('entity=Resource') ? resourceCols : principalCols);
      }
      return base(u, opts);
    });

    const { user } = renderWizard({}, authFetch);
    await user.click((await screen.findAllByText('+ Attribute'))[0]); // Subjects Include list
    expect(await screen.findByRole('option', { name: 'department (2)' })).toBeInTheDocument();

    releaseSchema();
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('schema=true')));
    await expect(screen.findByRole('option', { name: 'department (0)' })).rejects.toThrow();
    expect(screen.getByRole('option', { name: 'department (2)' })).toBeInTheDocument();
  });

  it('steps Subjects → Resources → Layout → Save & share and back', async () => {
    const { user } = renderWizard();
    await user.click(screen.getByText('Next'));
    expect(await screen.findByText(/Narrow down the resources/)).toBeInTheDocument();
    await user.click(screen.getByText('Next'));
    expect(await screen.findByText('Group & sort columns')).toBeInTheDocument();
    await user.click(screen.getByText('Next'));
    expect(await screen.findByRole('textbox', { name: 'Name' })).toBeInTheDocument();
    // The last step has no Next — its primary button shows the matrix.
    expect(screen.queryByText('Next')).not.toBeInTheDocument();
    await user.click(screen.getByText('Back'));
    expect(await screen.findByText('Group & sort columns')).toBeInTheDocument();
  });

  it('jumps to any step from the indicator', async () => {
    const { user } = renderWizard();
    await gotoStep(user, 'Layout');
    expect(await screen.findByText('Group & sort columns')).toBeInTheDocument();
    await gotoStep(user, 'Subjects');
    expect(screen.getByText(/Narrow down the users/)).toBeInTheDocument();
  });

  describe('Subjects — the row choice', () => {
    it('switches to identities and applies it', async () => {
      const { user, onApply } = renderWizard();
      await user.click(screen.getByRole('button', { name: /^Identities/ }));
      expect(screen.getByRole('button', { name: /^Identities/ })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByText(/Narrow down the identities/)).toBeInTheDocument();
      await showMatrix(user);
      expect(applied(onApply).rowType).toBe('identity');
    });

    it('clears subject conditions when the choice changes, and only then', async () => {
      const { user, onApply } = renderWizard({ initialFilter: { rowType: 'principal', subject: { include: [{ kind: 'attribute', field: 'department', values: ['Sales'] }], exclude: [] } } });
      // Re-picking the current choice keeps the condition.
      await user.click(screen.getByRole('button', { name: /^User accounts/ }));
      expect(screen.getByText('Sales')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /^Identities/ }));
      expect(screen.queryByText('Sales')).not.toBeInTheDocument();
      await showMatrix(user);
      expect(applied(onApply).subject.include).toEqual([]);
    });
  });

  describe('Resources — the column choice and More options', () => {
    it('starts on Resources and applies business-role rows once chosen', async () => {
      // Business roles are already the SOLL columns, so they are off the row axis
      // by default (#937); the choice is what gets saved and POSTed.
      const { user, onApply } = renderWizard();
      await gotoStep(user, 'Resources');
      expect(screen.getByRole('button', { name: /^Resources Groups/ })).toHaveAttribute('aria-pressed', 'true');
      await user.click(screen.getByRole('button', { name: /^Resources and business roles/ }));
      expect(screen.getByRole('button', { name: /^Resources and business roles/ })).toHaveAttribute('aria-pressed', 'true');
      await showMatrix(user);
      expect(applied(onApply)).toMatchObject({ includeBusinessRoles: true, includeInheritedAccess: false });
    });

    it('shows the choice already made when adjusting a matrix that opted in', async () => {
      const { user } = renderWizard({ initialFilter: { rowType: 'principal', includeBusinessRoles: true } });
      await gotoStep(user, 'Resources');
      expect(screen.getByRole('button', { name: /^Resources and business roles/ })).toHaveAttribute('aria-pressed', 'true');
    });

    it('keeps "Include inherited access" behind a closed More options disclosure', async () => {
      const { user, onApply } = renderWizard();
      await gotoStep(user, 'Resources');
      const more = screen.getByRole('button', { name: /More options/ });
      expect(more).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('checkbox', { name: /Include inherited access/ })).not.toBeInTheDocument();

      await user.click(more);
      const box = screen.getByRole('checkbox', { name: /Include inherited access/ });
      expect(box).not.toBeChecked();
      await user.click(box);
      expect(box).toBeChecked();
      await showMatrix(user);
      expect(applied(onApply)).toMatchObject({ includeInheritedAccess: true, includeBusinessRoles: false });
    });
  });

  it('opens More options already expanded when inherited access is on', async () => {
    const { user } = renderWizard({ initialFilter: { rowType: 'principal', includeInheritedAccess: true } });
    await gotoStep(user, 'Resources');
    expect(screen.getByRole('button', { name: /More options/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('checkbox', { name: /Include inherited access/ })).toBeChecked();
  });

  it('adjusts a partial filter (no sortAttributes) through Layout and shows it', async () => {
    // A filter from a URL, an older saved matrix or the seeded default may lack
    // fields; adjusting one used to crash on the Sort step.
    const { user, onApply } = renderWizard({ initialFilter: { rowType: 'principal' } });
    await gotoStep(user, 'Layout');
    expect(await screen.findByText('Group & sort columns')).toBeInTheDocument();
    expect(screen.getByText('Sort by')).toBeInTheDocument();
    await showMatrix(user);
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ sortAttributes: [{ attribute: 'department', dir: 'asc' }] }),
      'all',
    );
  });

  it('resets back to the requested step when reopened after navigating away', async () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return h('div', null,
        h('button', { onClick: () => setOpen((o) => !o) }, 'toggle'),
        h(MatrixFilterWizard, { open, initialStep: 'sort', onApply: vi.fn(), onClose: () => setOpen(false) }),
      );
    }
    renderWithProviders(h(Harness), { auth: { authFetch: makeWizardFetch() }, features: { matrixSharing: true } });
    const user = userEvent.setup();

    expect(await screen.findByText('Group & sort columns')).toBeInTheDocument();
    await gotoStep(user, 'Subjects');
    expect(screen.queryByText('Group & sort columns')).not.toBeInTheDocument();

    await user.click(screen.getByText('toggle')); // close
    await user.click(screen.getByText('toggle')); // reopen
    expect(await screen.findByText('Group & sort columns')).toBeInTheDocument();
  });

  describe('initialStep', () => {
    it.each([
      [undefined, /Narrow down the users/],
      ['subjects', /Narrow down the users/],
      ['setup', /Narrow down the users/],
      ['resources', /Narrow down the resources/],
      ['layout', /^Group & sort columns$/],
      ['sort', /^Group & sort columns$/],
      ['content', /^Group & sort columns$/],
      ['nonsense', /Narrow down the users/],
    ])('opens %s on the step that holds it', (initialStep, marker) => {
      renderWizard({ initialStep });
      expect(screen.getByText(marker)).toBeInTheDocument();
    });

    it.each(['save', 'share'])('opens %s on Save & share', (initialStep) => {
      renderWizard({ initialStep });
      expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
      expect(screen.queryByText(/Narrow down the users/)).not.toBeInTheDocument();
    });
  });

  it('adds an attribute condition through the AttributePicker and shows it as a chip', async () => {
    const { user } = renderWizard();
    await user.click(screen.getAllByText('+ Attribute')[0]);
    expect(await screen.findByText('Add attribute filter')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'department' } });
    await user.click(await screen.findByRole('checkbox', { name: /Engineering/i }));
    await user.click(screen.getByText('Add'));
    expect(await screen.findByText('Engineering')).toBeInTheDocument();
  });

  it('adds, updates and removes a context condition, naming the context', async () => {
    const { user, onApply } = renderWizard();
    await user.click(screen.getAllByText('+ Context')[1]); // Exclude list
    await user.click(screen.getByRole('button', { name: 'Pick in: Pick a context for exclude' }));
    expect(await screen.findByText('Sales tree')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'incl. descendants' }));
    await showMatrix(user);
    expect(applied(onApply).subject.exclude).toEqual([{ kind: 'context', contextId: 'ctx-picked', includeChildren: false }]);
  });

  it('removes a condition', async () => {
    const { user } = renderWizard({ initialFilter: { rowType: 'principal', subject: { include: [{ kind: 'attribute', field: 'department', values: ['HR'] }], exclude: [] } } });
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByText('HR')).not.toBeInTheDocument();
    expect(screen.getByText(/every user matches/)).toBeInTheDocument();
  });

  describe('Layout — group & sort', () => {
    it('adds a sort attribute and toggles direction', async () => {
      const { user, onApply } = renderWizard();
      await gotoStep(user, 'Layout');
      await user.click(screen.getByTitle(/Toggle ascending/i));
      await user.click(screen.getByText('+ Add attribute'));
      await showMatrix(user);
      expect(applied(onApply).sortAttributes).toEqual([
        { attribute: 'department', dir: 'desc' },
        { attribute: 'jobTitle', dir: 'asc' },
      ]);
    });

    it('changes, removes and folds sort levels, and carries them to the matrix', async () => {
      const { user, onApply } = renderWizard();
      await gotoStep(user, 'Layout');
      await user.click(screen.getByText('+ Add attribute'));
      fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'city' } });
      await user.click(screen.getAllByTitle('Remove')[1]);
      const fold = screen.getByRole('checkbox', { name: /Open with the first group folded/ });
      expect(fold).not.toBeChecked(); // 'auto' at 1,500 assignments stays unfolded
      await user.click(fold);
      await showMatrix(user);
      expect(applied(onApply)).toMatchObject({ sortAttributes: [{ attribute: 'city', dir: 'asc' }], foldOnLoad: true });
    });

    it('sorts by a picked hierarchy, and back to attributes', async () => {
      const { user, onApply } = renderWizard();
      await gotoStep(user, 'Layout');
      await user.click(screen.getByText('By Manager Hierarchy'));
      // The first hierarchy is chosen as soon as the list loads.
      await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('ctx-1'));
      await showMatrix(user);
      expect(applied(onApply).sortHierarchy).toEqual({ contextId: 'ctx-1' });

      await gotoStep(user, 'Layout');
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ctx-1' } });
      await user.click(screen.getByText('By attributes'));
      expect(screen.getByText('Sort by')).toBeInTheDocument();
    });

    it('says when there is no Manager Hierarchy to sort by', async () => {
      const base = makeWizardFetch();
      const authFetch = makeAuthFetch((url, opts) => (String(url).includes('contextType=ManagerHierarchy') ? { data: [] } : base(url, opts)));
      const { user } = renderWizard({}, authFetch);
      await gotoStep(user, 'Layout');
      await user.click(screen.getByText('By Manager Hierarchy'));
      expect(await screen.findByText(/No Manager Hierarchy context found/)).toBeInTheDocument();
    });

    it('switches to Manager Hierarchy and loads the hierarchy list', async () => {
      const { user } = renderWizard();
      await gotoStep(user, 'Layout');
      await user.click(screen.getByText('By Manager Hierarchy'));
      expect(await screen.findByText(/Org Chart \(99\)/)).toBeInTheDocument();
    });
  });

  describe('Layout — roll up', () => {
    it('rolls up by an attribute with the chosen content, and disables grouping while on', async () => {
      const { user, onApply } = renderWizard({ initialFilter: { rowType: 'principal', sortHierarchy: { contextId: 'ctx-1' } } });
      await gotoStep(user, 'Layout');
      const rollup = screen.getByRole('group', { name: 'Roll up' });
      expect(within(rollup).getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'By attributes' })).toBeEnabled();

      await user.click(within(rollup).getByRole('button', { name: 'By attribute' }));
      const select = screen.getByRole('combobox', { name: 'Roll up by attribute' });
      expect(select).toHaveValue('department'); // first sensible attribute, never displayName
      fireEvent.change(select, { target: { value: 'jobTitle' } });
      await user.click(screen.getByRole('button', { name: /^Resources only/ }));
      await user.click(screen.getByRole('button', { name: /^Percentage/ }));

      // Grouping stays on screen, disabled, with the reason.
      expect(screen.getByText(/Roll-up is on — the columns are the roll-up groups/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'By attributes' })).toBeDisabled();

      await showMatrix(user);
      expect(applied(onApply)).toMatchObject({
        rollup: 'jobTitle', rollupKind: 'attribute', rollupContextId: null,
        rollupContent: 'resources-only', rollupMetric: 'percent', sortHierarchy: null,
      });
    });

    it('hides the Resources step for a roles-only roll-up, and brings it back when switched off', async () => {
      const { user, onApply } = renderWizard();
      await gotoStep(user, 'Layout');
      await user.click(screen.getByRole('button', { name: 'By attribute' }));
      await user.click(screen.getByRole('button', { name: /^Business roles only/ }));
      expect(screen.queryByRole('button', { name: /Go to step \d+: Resources$/ })).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Off' }));
      expect(screen.getByRole('button', { name: /Go to step 2: Resources$/ })).toBeInTheDocument();
      expect(screen.queryByText(/Roll-up is on/)).not.toBeInTheDocument();
      expect(screen.getByTitle(/Toggle ascending/i)).toBeEnabled();
      await showMatrix(user);
      expect(applied(onApply)).toMatchObject({ rollup: null, rollupKind: 'attribute' });
    });

    it('rolls up by a picked context and names it', async () => {
      const { user, onApply } = renderWizard();
      await gotoStep(user, 'Layout');
      await user.click(screen.getByRole('button', { name: 'By context' }));
      // Choosing By context opens the picker straight away.
      await user.click(screen.getByRole('button', { name: 'Pick in: Roll up by a context' }));
      expect(screen.getByText('Sales tree')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Change context…' })).toBeInTheDocument();
      expect(screen.getByTitle(/Toggle ascending/i)).toBeDisabled();
      await showMatrix(user);
      expect(applied(onApply)).toMatchObject({ rollupKind: 'context', rollupContextId: 'ctx-picked', rollup: null });
    });

    it('names a saved context roll-up from the API, and asks for one when none is picked', async () => {
      const { user } = renderWizard({ initialFilter: { rowType: 'principal', rollupKind: 'context', rollupContextId: 'ctx-9' } });
      await gotoStep(user, 'Layout');
      expect(await screen.findByText('Context ctx-9')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'By context' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('keeps a stored roll-up attribute the column list does not offer', async () => {
      const { user } = renderWizard({ initialFilter: { rowType: 'principal', rollup: 'ext.costCenter' } });
      await gotoStep(user, 'Layout');
      const select = screen.getByRole('combobox', { name: 'Roll up by attribute' });
      expect(select).toHaveValue('ext.costCenter');
      expect(within(select).getByRole('option', { name: /cost center/i })).toBeInTheDocument();
    });
  });

  describe('Layout — open with', () => {
    // #1202: trends & breakdown is opt-in per matrix. Both halves matter — true
    // after the tick, false without one — because the panel used to be unconditional.
    it('ticks trends & breakdown and applies it with the matrix', async () => {
      const { user, onApply } = renderWizard();
      await gotoStep(user, 'Layout');
      const box = screen.getByRole('checkbox', { name: /Show trends & breakdown above the matrix/ });
      expect(box).not.toBeChecked();
      await user.click(box);
      await showMatrix(user);
      expect(applied(onApply)).toMatchObject({ showTrends: true });
    });

    it('applies a matrix without the trends panel when the box is left alone', async () => {
      const { user, onApply } = renderWizard();
      await showMatrix(user);
      expect(applied(onApply)).toMatchObject({ showTrends: false });
    });

    it('sets the default lens and carries it to the matrix', async () => {
      const { user, onApply } = renderWizard({ initialManaged: 'managed' });
      await gotoStep(user, 'Layout');
      const lens = screen.getByRole('group', { name: 'Default lens' });
      expect(within(lens).getByRole('button', { name: 'Governed' })).toHaveAttribute('aria-pressed', 'true');
      await user.click(within(lens).getByRole('button', { name: 'Gaps' }));
      expect(within(lens).getByRole('button', { name: 'Governed' })).toHaveAttribute('aria-pressed', 'false');
      await showMatrix(user);
      expect(onApply.mock.calls.at(-1)[1]).toBe('gaps');
    });
  });

  it('offers no orientation control on any step', async () => {
    const { user } = renderWizard();
    for (const label of ['Subjects', 'Resources', 'Layout', 'Save & share']) {
      await gotoStep(user, label);
      expect(screen.queryByText(/orientation|rotate|swap axes|rows as subjects/i)).not.toBeInTheDocument();
    }
  });

  it('calls onClose, and never onApply, when Cancel is clicked', async () => {
    const { user, onApply, onClose } = renderWizard();
    await user.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });
});
