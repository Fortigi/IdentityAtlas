// @vitest-environment jsdom
//
// The API's access flag, honoured wherever a detail page names another object:
// accessible:false → the name, lighter, "No access to details", no button;
// absent (every ordinary reader) → a link as before.

import { describe, it, expect, vi } from 'vitest';
import EntityLink, { NoAccessName, OpenDetailsButton } from './EntityLink';
import { canOpenRef, NO_ACCESS_HINT } from './entityLink.helpers';
import ExpandedItemsList from './ExpandedItemsList';
import LinkedAccountsPanel from './LinkedAccountsPanel';
import { RelationshipDiffGroups } from './SnapshotDiffView';
import { renderSummaryWithLink } from './RecentChangesSection.helpers';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('canOpenRef', () => {
  it.each([
    [{ id: ID, onOpenDetail: () => {} }, true],
    [{ id: ID, accessible: true, onOpenDetail: () => {} }, true],
    [{ id: ID, accessible: false, onOpenDetail: () => {} }, false],
    [{ id: '', onOpenDetail: () => {} }, false],
    [{ id: ID }, false],
  ])('%o → %s', (ref, out) => {
    expect(canOpenRef(ref)).toBe(out);
  });
});

describe('EntityLink', () => {
  it('opens the object when the API did not refuse it', async () => {
    const onOpenDetail = vi.fn();
    renderWithProviders(<EntityLink kind="user" id={ID} label="Tim" onOpenDetail={onOpenDetail} />);
    await userEvent.click(screen.getByRole('button', { name: 'Tim' }));
    expect(onOpenDetail).toHaveBeenCalledWith('user', ID, 'Tim');
  });

  it('names an object the reader may not open, without a button, with the hint', () => {
    renderWithProviders(<EntityLink kind="user" id={ID} label="Olga" accessible={false} onOpenDetail={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('no-access-ref')).toHaveAttribute('title', NO_ACCESS_HINT);
    expect(screen.getByTestId('no-access-ref')).toHaveTextContent('Olga (no access to details)');
  });

  it('is plain text with nothing to open (no handler)', () => {
    renderWithProviders(<EntityLink kind="user" id={ID} label="Ann" plainClassName="font-medium" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Ann')).toHaveClass('font-medium');
    expect(screen.queryByTestId('no-access-ref')).toBeNull();
  });

  it('OpenDetailsButton shows only for an openable object', async () => {
    const onOpenDetail = vi.fn();
    const { unmount } = renderWithProviders(<OpenDetailsButton kind="identity" id={ID} name="Tim" accessible={false} onOpenDetail={onOpenDetail} />);
    expect(screen.queryByRole('button')).toBeNull();
    unmount();
    renderWithProviders(<OpenDetailsButton kind="identity" id={ID} name="Tim" onOpenDetail={onOpenDetail} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open Tim' }));
    expect(onOpenDetail).toHaveBeenCalledWith('identity', ID, 'Tim');
  });

  it('NoAccessName keeps an extra class (a struck-through historical row)', () => {
    renderWithProviders(<NoAccessName label="Old" className="line-through" />);
    expect(screen.getByTestId('no-access-ref')).toHaveClass('line-through');
  });
});

describe('the flag in the places that link', () => {
  it('the graph list: a member the owner may not open is listed, not linked', () => {
    const items = [
      { key: 'user:1', label: 'Tim', kind: 'item', entityKind: 'user', entityId: ID },
      { key: 'user:2', label: 'Olga', kind: 'item', entityKind: 'user', entityId: 'b', accessible: false },
    ];
    renderWithProviders(<ExpandedItemsList label="Direct Members" items={items} onOpenDetail={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Tim' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Olga/ })).toBeNull();
    expect(screen.getByText('Olga')).toBeInTheDocument();
  });

  it('a timeline line names an inaccessible counterparty without a link', () => {
    const ev = { summary: 'Added to Finance-Admins', counterpartyLabel: 'Finance-Admins', counterpartyId: ID, accessible: false };
    renderWithProviders(<p>{renderSummaryWithLink(ev, 'resource', vi.fn())}</p>);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('no-access-ref')).toHaveTextContent('Finance-Admins');
  });

  it('a timeline line still links an accessible counterparty', async () => {
    const onOpenDetail = vi.fn();
    const ev = { summary: 'Added to Finance-Admins', counterpartyLabel: 'Finance-Admins', counterpartyId: ID };
    renderWithProviders(<p>{renderSummaryWithLink(ev, 'resource', onOpenDetail)}</p>);
    await userEvent.click(screen.getByRole('button', { name: 'Finance-Admins' }));
    expect(onOpenDetail).toHaveBeenCalledWith('resource', ID, 'Finance-Admins');
  });

  it('a diff row names an inaccessible item without a link', () => {
    const groups = [{ key: 'Members', label: 'Members', beforeCount: 0, afterCount: 1, rows: [
      { key: 'u', status: 'added', before: null, after: { key: 'u', label: 'Olga', kind: 'user', id: ID, accessible: false } },
    ] }];
    renderWithProviders(<RelationshipDiffGroups groups={groups} beforeLabel="Then" afterLabel="Now" onOpenDetail={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Olga/ })).toBeNull();
    expect(screen.getByTestId('no-access-ref')).toHaveTextContent('Olga');
  });

  it('linked accounts: read-only has no override buttons, and an inaccessible account is not linked', () => {
    const members = [{ principalId: ID, displayName: 'Tim (admin)', linkConfidence: 0.9, accessible: false }];
    renderWithProviders(<LinkedAccountsPanel members={members} busyMember={null} onOpenDetail={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Tim/ })).toBeNull();
    expect(screen.getByTestId('no-access-ref')).toHaveTextContent('Tim (admin)');
  });
});
