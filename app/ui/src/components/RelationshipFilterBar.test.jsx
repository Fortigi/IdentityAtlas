// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  renderWithProviders,
  makeAuthFetch,
  screen,
  userEvent,
} from '@ui/test-utils/renderWithProviders';
import RelationshipFilterBar from '@ui/components/RelationshipFilterBar';

const EDGES = {
  '/api/relationship-edges': {
    edges: [
      { id: 'principal.owner', label: 'has an owner', ops: ['exists', 'absent', 'eq', 'lt', 'gt'], available: true },
      { id: 'principal.sponsor', label: 'has a sponsor', ops: ['exists', 'absent', 'eq', 'lt', 'gt'], available: false },
    ],
  },
};

function setup(relFilters = []) {
  const onAdd = vi.fn();
  const onRemove = vi.fn();
  const af = makeAuthFetch(EDGES);
  renderWithProviders(
    <RelationshipFilterBar entity="Principal" authFetch={af} relFilters={relFilters} onAdd={onAdd} onRemove={onRemove} />,
    { auth: { authFetch: af } },
  );
  return { onAdd, onRemove };
}

// The "+ Add relationship" button only appears once the edge list has loaded
// (useFetch resolves async), so open the picker via findBy.
async function openPicker(user) {
  await user.click(await screen.findByText('+ Add relationship'));
  return screen.findByLabelText('Relationship edge');
}

describe('RelationshipFilterBar', () => {
  it('renders active relationship conditions as readable pills (label resolves once edges load)', async () => {
    setup([{ edge: 'principal.owner', op: 'lt', n: 2 }]);
    expect(await screen.findByText('has an owner: count < 2')).toBeInTheDocument();
  });

  it('adds an existence condition via the picker', async () => {
    const user = userEvent.setup();
    const { onAdd } = setup();
    await openPicker(user);

    await user.selectOptions(screen.getByLabelText('Relationship edge'), 'principal.owner');
    await user.selectOptions(screen.getByLabelText('Relationship operator'), 'absent');
    await user.click(screen.getByText('Add'));

    expect(onAdd).toHaveBeenCalledWith({ edge: 'principal.owner', op: 'absent' });
  });

  it('reveals a count input for count operators and passes n', async () => {
    const user = userEvent.setup();
    const { onAdd } = setup();
    await openPicker(user);
    await user.selectOptions(screen.getByLabelText('Relationship edge'), 'principal.owner');
    await user.selectOptions(screen.getByLabelText('Relationship operator'), 'lt');

    const nInput = screen.getByLabelText('Relationship count');
    await user.clear(nInput);
    await user.type(nInput, '2');
    await user.click(screen.getByText('Add'));

    expect(onAdd).toHaveBeenCalledWith({ edge: 'principal.owner', op: 'lt', n: 2 });
  });

  it('disables an unavailable edge (opt-in phase not run)', async () => {
    const user = userEvent.setup();
    setup();
    await openPicker(user);
    const opt = screen.getByRole('option', { name: /has a sponsor \(no data yet\)/ });
    expect(opt).toBeDisabled();
  });

  it('removes an active condition', async () => {
    const user = userEvent.setup();
    const { onRemove } = setup([{ edge: 'principal.owner', op: 'absent' }]);
    await user.click(screen.getByTitle('Remove relationship filter'));
    expect(onRemove).toHaveBeenCalledWith('principal.owner');
  });
});
