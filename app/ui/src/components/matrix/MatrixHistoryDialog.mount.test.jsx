// @vitest-environment jsdom
//
// "Who changed this matrix?" — the trail dialog behind a saved matrix.
//
// The fixtures discriminate: one event renames AND re-cuts the matrix (so a
// dialog that rendered only the first change fails), one is a creation with no
// changes at all, and the empty case is a matrix whose row exists but whose
// history predates the audit trigger — which must not read as "nobody has ever
// changed it".

import { describe, it, expect, vi, afterEach } from 'vitest';
import MatrixHistoryDialog from './MatrixHistoryDialog';
import { renderWithProviders, makeAuthFetch, screen, within, userEvent } from '@ui/test-utils/renderWithProviders';

const NOW = new Date('2026-09-22T12:00:00Z');

const FULL = {
  id: 'sf-1',
  name: 'Sales team access',
  createdBy: 'wim@example.com',
  createdAt: '2026-03-01T10:00:00Z',
  updatedBy: 'anna@example.com',
  updatedAt: '2026-09-21T12:00:00Z',
  events: [
    {
      at: '2026-09-21T12:00:00Z',
      actor: 'anna@example.com',
      operation: 'changed',
      changes: [
        { field: 'name', label: 'Name', from: 'Sales', to: 'Sales team access' },
        { field: 'filter', label: 'Matrix contents', parts: ['subjects', 'roll-up'] },
      ],
    },
    { at: '2026-03-01T10:00:00Z', actor: 'wim@example.com', operation: 'created', changes: [] },
  ],
};

function render({ body = FULL } = {}) {
  const onClose = vi.fn();
  const authFetch = makeAuthFetch((url) => (String(url).includes('/history') ? body : undefined));
  renderWithProviders(
    <MatrixHistoryDialog savedFilterId="sf-1" savedName="Sales team access" onClose={onClose} />,
    { auth: { authFetch } },
  );
  return { onClose, authFetch, user: userEvent.setup() };
}

afterEach(() => vi.useRealTimers());

describe('MatrixHistoryDialog', () => {
  it('reads the trail for the matrix it was opened on', async () => {
    const { authFetch } = render();
    await screen.findByRole('list', { name: 'Matrix history' });
    expect(authFetch).toHaveBeenCalledWith('/api/matrix/saved-filters/sf-1/history');
  });

  it('names the creator and the last person to change it', async () => {
    render();
    expect(await screen.findByText('Created by wim@example.com · last changed by anna@example.com')).toBeInTheDocument();
  });

  it('lists every change an event made, newest first, with who made it', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    render();
    const list = await screen.findByRole('list', { name: 'Matrix history' });
    const [latest, first] = within(list).getAllByRole('listitem').filter(li => li.parentElement === list);

    expect(within(latest).getByText('anna@example.com changed it')).toBeInTheDocument();
    expect(within(latest).getByText('Name: Sales → Sales team access')).toBeInTheDocument();
    // Both changes of the one event, not just the first.
    expect(within(latest).getByText('Matrix contents: subjects, roll-up')).toBeInTheDocument();
    expect(within(latest).getByText('1d ago')).toBeInTheDocument();

    expect(within(first).getByText('wim@example.com saved this matrix')).toBeInTheDocument();
  });

  it('says history is only kept from a point in time, rather than that nothing changed', async () => {
    render({ body: { ...FULL, events: [] } });
    // The creator is still named — that comes from the row, not the trail.
    expect(await screen.findByText(/Created by wim@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/No changes recorded yet/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Matrix history' })).not.toBeInTheDocument();
  });

  it('closes on Done', async () => {
    const { onClose, user } = render();
    await screen.findByRole('list', { name: 'Matrix history' });
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });
});
