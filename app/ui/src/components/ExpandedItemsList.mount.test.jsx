// @vitest-environment jsdom
// History rows (deleted in the source) must never read as current access: they
// are folded away by default, labelled once shown, and kept out of the count.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderWithProviders, screen, fireEvent, cleanup } from '@ui/test-utils/renderWithProviders';
import ExpandedItemsList from '@ui/components/ExpandedItemsList';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const live = { key: 'access-package:new', label: 'Head of Finance', kind: 'item', entityKind: 'access-package', entityId: 'new' };
const old = {
  key: 'access-package:old', label: 'Head of Finance', kind: 'item', entityKind: 'access-package', entityId: 'old',
  deleted: true, deletedAt: '2026-09-08T14:32:00Z',
};

function renderList(items, onOpenDetail = vi.fn()) {
  renderWithProviders(<ExpandedItemsList label="Business Roles" items={items} loading={false} onOpenDetail={onOpenDetail} />);
  return onOpenDetail;
}

describe('ExpandedItemsList — historical rows', () => {
  it('hides history by default and counts only current rows', () => {
    renderList([live, old]);
    expect(screen.getAllByRole('button', { name: 'Head of Finance' })).toHaveLength(1);
    expect(screen.getByText('1 · 1 historical')).toBeInTheDocument();
    expect(screen.queryByText('Historical')).not.toBeInTheDocument();
  });

  it('unfolds the history labelled, opens it, and folds it again', () => {
    const onOpen = renderList([live, old]);
    const toggle = screen.getByRole('button', { name: /Show 1 historical/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);

    const rows = screen.getAllByRole('button', { name: 'Head of Finance' });
    expect(rows).toHaveLength(2);
    const badge = screen.getByText('Historical');
    expect(badge).toHaveAttribute('title', expect.stringMatching(/^Deleted /));
    // The historical row is the second one and still opens its own detail page.
    fireEvent.click(rows[1]);
    expect(onOpen).toHaveBeenCalledWith('access-package', 'old', 'Head of Finance');

    fireEvent.click(screen.getByRole('button', { name: /Hide 1 historical/ }));
    expect(screen.getAllByRole('button', { name: 'Head of Finance' })).toHaveLength(1);
  });

  it('says there is nothing current when only history exists', () => {
    renderList([old]);
    expect(screen.getByText('No current items.')).toBeInTheDocument();
    expect(screen.getByText('0 · 1 historical')).toBeInTheDocument();
  });

  it('exports only what is on screen: history once unfolded, marked Historical', async () => {
    const blobs = [];
    URL.createObjectURL = vi.fn((b) => { blobs.push(b); return 'blob:x'; });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderList([live, old]);

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    fireEvent.click(screen.getByRole('button', { name: /Show 1 historical/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    const [folded, unfolded] = await Promise.all(blobs.map((b) => b.text()));
    expect(folded.split('\r\n')).toEqual(['Name,Type,Via,Status', '"Head of Finance","Business Role","","Current"']);
    expect(unfolded.split('\r\n')[2]).toBe('"Head of Finance","Business Role","","Historical"');
  });

  it('shows no history toggle when every row is current', () => {
    renderList([live]);
    expect(screen.queryByRole('button', { name: /historical/ })).not.toBeInTheDocument();
    expect(screen.queryByText('No current items.')).not.toBeInTheDocument();
  });
});
