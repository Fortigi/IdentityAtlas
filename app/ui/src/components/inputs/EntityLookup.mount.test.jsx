// @vitest-environment jsdom
//
// The control exists so a parameter stores an entity's ID rather than a name
// that may match three of them, so the assertions are about what leaves the
// component (`onChange`) as much as about what it draws.

import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, fireEvent, waitFor, makeAuthFetch, jsonResponse }
  from '@ui/test-utils/renderWithProviders';
import EntityLookup, { disambiguate } from '@ui/components/inputs/EntityLookup';

const OPTIONS = [
  { value: 'app-1', label: 'Ledger Engineering', hint: '16,387 members · Catalogue' },
  { value: 'app-2', label: 'Ledger Audit', hint: '12 members · Catalogue' },
];

/** An authFetch that answers a search with `q` echoed, and an ids request. */
function lookupFetch({ search = OPTIONS, byId = OPTIONS } = {}) {
  return makeAuthFetch(async (url) => {
    const u = new URL(url, 'http://localhost');
    if (u.searchParams.has('ids')) {
      const ids = u.searchParams.get('ids').split(',');
      return { data: byId.filter(o => ids.includes(o.value)) };
    }
    const q = u.searchParams.get('q') ?? '';
    return { source: 'things', q, data: typeof search === 'function' ? search(q) : search };
  });
}

const mount = (props = {}, auth = {}) => renderWithProviders(
  <EntityLookup source="things" value={[]} onChange={() => {}} inputId="pick" {...props} />,
  { auth: { authFetch: lookupFetch(), ...auth } },
);

const box = () => screen.getByRole('combobox');

describe('EntityLookup', () => {
  it('offers the first options as soon as the box is focused, before anything is typed', async () => {
    mount();
    fireEvent.focus(box());
    expect(await screen.findByRole('option', { name: /Ledger Engineering/ })).toBeInTheDocument();
    // The hint is what tells two same-named entries apart, so it has to render.
    expect(screen.getByText('16,387 members · Catalogue')).toBeInTheDocument();
  });

  it('stores the id, never the label, when an option is picked', async () => {
    // The whole reason this control exists. A component that emitted the label
    // would look identical on screen and reintroduce the ambiguity.
    const onChange = vi.fn();
    mount({ onChange });
    fireEvent.focus(box());
    fireEvent.click(await screen.findByRole('option', { name: /Ledger Engineering/ }));
    expect(onChange).toHaveBeenCalledWith(['app-1']);
  });

  it('appends to the selection rather than replacing it', async () => {
    const onChange = vi.fn();
    mount({ value: ['app-9'], onChange });
    fireEvent.focus(box());
    fireEvent.click(await screen.findByRole('option', { name: /Ledger Audit/ }));
    expect(onChange).toHaveBeenCalledWith(['app-9', 'app-2']);
  });

  it('will not add the same entry twice', async () => {
    const onChange = vi.fn();
    mount({ value: ['app-1'], onChange });
    fireEvent.focus(box());
    const already = await screen.findByRole('option', { name: /Ledger Engineering/ });
    expect(already).toBeDisabled();
    fireEvent.click(already);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('searches for what was typed, and passes the term to the server', async () => {
    const { authFetch } = mount();
    fireEvent.change(box(), { target: { value: 'audit' } });
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('q=audit')));
    expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('/api/lookups/things'));
  });

  it('ignores a reply for a term that is no longer on screen', async () => {
    // The server echoes the term it searched. Without checking it, a slow reply
    // for "led" lands after the user has typed "ledger audit" and the list
    // silently shows the wrong answer.
    const authFetch = makeAuthFetch(async (url) => {
      const q = new URL(url, 'http://localhost').searchParams.get('q');
      return q === 'stale'
        ? { source: 'things', q: 'an-older-term', data: [{ value: 'x', label: 'Should Not Appear' }] }
        : { source: 'things', q, data: OPTIONS };
    });
    renderWithProviders(
      <EntityLookup source="things" value={[]} onChange={() => {}} inputId="pick" />, { auth: { authFetch } });

    fireEvent.change(box(), { target: { value: 'stale' } });
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('q=stale')));
    expect(screen.queryByText('Should Not Appear')).not.toBeInTheDocument();
    expect(screen.getByText('Searching…')).toBeInTheDocument();
  });

  it('says nothing matches only once it has actually looked', async () => {
    const authFetch = makeAuthFetch(async (url) => {
      const q = new URL(url, 'http://localhost').searchParams.get('q');
      return { source: 'things', q, data: [] };
    });
    renderWithProviders(
      <EntityLookup source="things" value={[]} onChange={() => {}} inputId="pick" />, { auth: { authFetch } });
    fireEvent.change(box(), { target: { value: 'zzz' } });
    expect(await screen.findByText(/Nothing matches “zzz”/)).toBeInTheDocument();
  });

  it('shows the selection as removable chips, named not numbered', async () => {
    const onChange = vi.fn();
    mount({ value: ['app-1'], onChange });
    expect(await screen.findByText('Ledger Engineering')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ledger Engineering' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('resolves an id it was handed without a label — a bookmarked report', async () => {
    const { authFetch } = mount({ value: ['app-2'] });
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('ids=app-2')));
    expect(await screen.findByText('Ledger Audit')).toBeInTheDocument();
  });

  it('falls back to showing the raw id when nothing can name it', async () => {
    mount({ value: ['ghost-id'] });
    expect(await screen.findByText('ghost-id')).toBeInTheDocument();
  });

  it('keeps working when the lookup fails, rather than blanking the form', async () => {
    const authFetch = makeAuthFetch(() => jsonResponse({ error: 'boom' }, { ok: false, status: 500 }));
    renderWithProviders(
      <EntityLookup source="things" value={['app-1']} onChange={() => {}} inputId="pick" />, { auth: { authFetch } });
    fireEvent.focus(box());
    expect(await screen.findByText(/Nothing to pick here yet/)).toBeInTheDocument();
    // The existing selection survives a failed lookup.
    expect(screen.getByText('app-1')).toBeInTheDocument();
  });

  it('draws its own label only when it is given one', () => {
    const { rerender } = mount();
    // SchemaConfigForm owns the label; two would give the field two names.
    expect(screen.queryByText('Pick a thing')).not.toBeInTheDocument();
    rerender(<EntityLookup source="things" value={[]} onChange={() => {}} inputId="pick" label="Pick a thing" />);
    expect(screen.getByText('Pick a thing')).toBeInTheDocument();
  });
});

describe('disambiguate', () => {
  it('appends a slice of the id only to labels that collide in one list', () => {
    // Three applications under one name is the case the picker exists for: it
    // must not offer three rows a person cannot tell apart.
    const out = disambiguate([
      { value: 'aaaaaaaa-1111', label: 'Catalog Engineering', hint: '16,387 members' },
      { value: 'bbbbbbbb-2222', label: 'Catalog Engineering', hint: '2,630 members' },
      { value: 'cccccccc-3333', label: 'Ledger Audit', hint: '12 members' },
    ]);
    expect(out[0].hint).toBe('16,387 members · id aaaaaaaa');
    expect(out[1].hint).toBe('2,630 members · id bbbbbbbb');
    expect(out[2].hint).toBe('12 members');
  });

  it('still disambiguates when there is no hint to append to', () => {
    const out = disambiguate([{ value: 'aaaaaaaa-1', label: 'Same' }, { value: 'bbbbbbbb-2', label: 'Same' }]);
    expect(out.map(o => o.hint)).toEqual(['id aaaaaaaa', 'id bbbbbbbb']);
  });

  it('leaves a list with no collisions untouched', () => {
    const input = [{ value: 'a', label: 'One', hint: 'x' }, { value: 'b', label: 'Two' }];
    expect(disambiguate(input)).toEqual(input);
  });
});
