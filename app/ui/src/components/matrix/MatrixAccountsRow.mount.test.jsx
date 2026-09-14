// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import MatrixAccountsRow from './MatrixAccountsRow';
import { renderWithProviders, screen, fireEvent } from '@ui/test-utils/renderWithProviders';

const alice = { id: 'id1', displayName: 'Alice', memberType: 'Identity' };
const carl = { id: 'u5', displayName: 'Carl' };
const aliceAad = { id: 'acc1', displayName: 'Alice', isAccountCol: true, parentId: 'id1', parent: alice, accountType: 'AAD' };
const aliceSap = { id: 'acc2', displayName: 'A.Jansen', isAccountCol: true, parentId: 'id1', parent: alice, accountType: 'SAP' };

function renderRow(overrides = {}) {
  const onOpenDetail = vi.fn();
  const result = renderWithProviders(
    h('table', null, h('thead', null,
      h(MatrixAccountsRow, {
        columns: [alice, carl],
        accountsByParent: new Map([['id1', [aliceAad, aliceSap]]]),
        onOpenDetail,
        ...overrides,
      }))),
  );
  return { ...result, onOpenDetail };
}

describe('MatrixAccountsRow', () => {
  it('fills the expanded identity span with one cell per account and nothing else', () => {
    const { container } = renderRow();
    const cells = [...container.querySelectorAll('th')];

    // Exactly Alice's two accounts — no "all accounts" roll-up cell, because the
    // identity has no column of its own while expanded. Carl is covered by a
    // rowSpan=2 names cell, so this row holds nothing for him either; anything
    // else here would shift the columns beside it.
    expect(cells).toHaveLength(2);
    expect(cells[0]).toHaveTextContent('Alice · AAD');
    expect(cells[1]).toHaveTextContent('A.Jansen · SAP');
    expect(screen.queryByText('Carl')).toBeNull();
    expect(container.textContent).not.toContain('All accounts');
  });

  it('opens the account — not the identity — from an account label', () => {
    const { onOpenDetail } = renderRow();
    fireEvent.click(screen.getByText('A.Jansen · SAP'));
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'acc2', 'A.Jansen');
  });

  it('leaves the account cells unpinned so they cannot cover the names row above', () => {
    // The whole <thead> is sticky; a `top-0` cell in this row would come to rest
    // at the same offset as the names row and paint over it.
    const { container } = renderRow();
    for (const th of container.querySelectorAll('th')) {
      expect(th.className).not.toContain('sticky');
      expect(th.className).not.toContain('top-0');
    }
  });

  it('renders an empty row when no column on screen is expanded', () => {
    const { container } = renderRow({ accountsByParent: new Map() });
    expect(container.querySelectorAll('th')).toHaveLength(0);
  });
});
