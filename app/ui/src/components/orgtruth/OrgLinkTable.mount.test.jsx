// @vitest-environment jsdom
//
// The per-link table the entity detail page uses: Confirm / Reject / Undo reach
// onOverride with the link id, Move asks through the in-app prompt for one of the
// other shown candidates of the same type (refusing anything else, a cancel does
// nothing), and the buttons only show for someone who may edit.
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, userEvent, waitFor, within } from '@ui/test-utils/renderWithProviders';
import OrgLinkTable from './OrgLinkTable';
import { toLinkCandidates } from './reviewRows';

const LINKS = [
  { id: 'l1', targetType: 'Principal', targetId: 'u1', label: 'alice.c', confidence: 45, status: 'proposed', signals: 'name', matchedField: 'owner', matchedValue: 'Alice' },
  { id: 'l2', targetType: 'Principal', targetId: 'u2', label: 'alice.contoso', confidence: 70, status: 'proposed', signals: 'email,name' },
  { id: 'l3', targetType: 'Resource', targetId: 'g1', label: 'GRP-Portal', confidence: 55, status: 'proposed', signals: 'token', analystOverride: 'rejected' },
  { id: 'l4', targetType: 'Unknown', targetId: 'x1', label: 'Somewhere', confidence: 10, status: 'proposed', signals: '' },
];

function render({ canEdit = true } = {}) {
  const onOverride = vi.fn();
  const onOpenDetail = vi.fn();
  renderWithProviders(
    <OrgLinkTable candidates={toLinkCandidates(LINKS)} canEdit={canEdit} busy={null} onOverride={onOverride} onOpenDetail={onOpenDetail} />,
  );
  return { onOverride, onOpenDetail };
}

const rowOf = (label) => within(screen.getByText(label).closest('tr'));
const promptForm = async () => (await screen.findByRole('textbox')).closest('form');

describe('OrgLinkTable', () => {
  it('lists the links best first with type, signals and where they matched', () => {
    render();
    const targets = screen.getAllByRole('row').slice(1).map(r => r.cells[0].firstChild.textContent);
    expect(targets).toEqual(['alice.contoso', 'GRP-Portal', 'alice.c', 'Somewhere']);
    expect(rowOf('alice.c').getByText('owner: Alice')).toBeInTheDocument();
    expect(rowOf('alice.contoso').getByText('email')).toBeInTheDocument();
    expect(screen.getAllByText('Account')).toHaveLength(2);
  });

  it('confirms, rejects and undoes by link id', async () => {
    const { onOverride } = render();
    await userEvent.click(rowOf('alice.contoso').getByRole('button', { name: 'Confirm' }));
    await userEvent.click(rowOf('alice.c').getByRole('button', { name: 'Reject' }));
    const portal = rowOf('GRP-Portal');
    expect(portal.queryByRole('button', { name: 'Confirm' })).toBeNull();
    await userEvent.click(portal.getByRole('button', { name: 'Undo' }));
    expect(onOverride.mock.calls).toEqual([['l2', 'confirmed'], ['l1', 'rejected'], ['l3', 'clear']]);
  });

  it('moves a link to another shown candidate of the same type', async () => {
    const { onOverride } = render();
    await userEvent.click(rowOf('alice.c').getByRole('button', { name: 'Move' }));
    const form = await promptForm();
    expect(form).toHaveTextContent('1. alice.contoso (70%)');
    await userEvent.click(within(form).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(onOverride).toHaveBeenCalledWith('l1', 'moved', 'u2'));
  });

  it('refuses a move to something not shown, and a cancelled prompt does nothing', async () => {
    const { onOverride } = render();
    await userEvent.click(rowOf('alice.c').getByRole('button', { name: 'Move' }));
    const form = await promptForm();
    const input = within(form).getByRole('textbox');
    await userEvent.clear(input);
    await userEvent.type(input, 'someone else');
    await userEvent.click(within(form).getByRole('button', { name: 'Move' }));
    expect(await screen.findByText('That is not one of the shown candidates.')).toBeInTheDocument();
    await userEvent.click(rowOf('alice.c').getByRole('button', { name: 'Move' }));
    await userEvent.click(within(await promptForm()).getByRole('button', { name: 'Cancel' }));
    expect(onOverride).not.toHaveBeenCalled();
    expect(rowOf('Somewhere').queryByRole('button', { name: 'Move' })).toBeNull();
  });

  it('opens a target\'s detail tab, and shows an unknown target type as plain text', async () => {
    const { onOpenDetail } = render();
    await userEvent.click(screen.getByRole('button', { name: 'alice.c' }));
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'u1', 'alice.c');
    await userEvent.click(screen.getByRole('button', { name: 'GRP-Portal' }));
    expect(onOpenDetail).toHaveBeenCalledWith('resource', 'g1', 'GRP-Portal');
    expect(screen.queryByRole('button', { name: 'Somewhere' })).toBeNull();
  });

  it('shows no buttons to someone who may not edit', () => {
    render({ canEdit: false });
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});
