// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  renderWithProviders, makeAuthFetch, jsonResponse, screen, fireEvent, waitFor,
} from '@ui/test-utils/renderWithProviders';
import ContextTreeSelector from './ContextTreeSelector';
import ContextSearchResults from './ContextSearchResults';
import { contextSearchUrl } from '@ui/hooks/useContextTrees';

beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });

const PAYROLL = {
  id: 'c1', displayName: 'Payroll', variant: 'synced', targetType: 'Resource', contextType: 'Application',
  matchedOn: ['CMDB Reference'],
};

describe('contextSearchUrl', () => {
  it('is null without a term, so nothing is fetched', () => {
    expect(contextSearchUrl('   ', true)).toBeNull();
  });

  it('asks for an extended search only with "All attributes" and 3+ characters', () => {
    expect(contextSearchUrl('CI0012345', true)).toBe('/api/contexts?search=CI0012345&extendedSearch=true');
    expect(contextSearchUrl('CI', true)).toBe('/api/contexts?search=CI');
    expect(contextSearchUrl('CI0012345', false)).toBe('/api/contexts?search=CI0012345');
  });

  it('encodes the term', () => {
    expect(contextSearchUrl('a&b c', false)).toBe('/api/contexts?search=a%26b+c');
  });
});

describe('ContextSearchResults', () => {
  it('lists matches with what they matched on, and opens one', async () => {
    const af = makeAuthFetch({ '/api/contexts?': { data: [PAYROLL] } });
    const onOpen = vi.fn();
    renderWithProviders(<ContextSearchResults term="CI0012345" extended onOpenContext={onOpen} />, { auth: { authFetch: af } });

    expect(await screen.findByText('Matched on CMDB Reference')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Payroll/ }));
    expect(onOpen).toHaveBeenCalledWith('c1', 'Payroll');
  });

  it('suggests "All attributes" when a normal search finds nothing', async () => {
    const af = makeAuthFetch({ '/api/contexts?': { data: [] } });
    renderWithProviders(<ContextSearchResults term="CI0012345" extended={false} />, { auth: { authFetch: af } });
    expect(await screen.findByText(/Tick “All attributes”/)).toBeInTheDocument();
  });

  it('does not suggest it when it is already on', async () => {
    const af = makeAuthFetch({ '/api/contexts?': { data: [] } });
    renderWithProviders(<ContextSearchResults term="CI0012345" extended />, { auth: { authFetch: af } });
    expect(await screen.findByText(/No context matches “CI0012345”/)).toBeInTheDocument();
    expect(screen.queryByText(/Tick/)).toBeNull();
  });

  it('shows a failed search as an error, not as "no matches"', async () => {
    const af = makeAuthFetch({ '/api/contexts?': jsonResponse({ error: 'x' }, { ok: false, status: 500 }) });
    renderWithProviders(<ContextSearchResults term="CI0012345" extended />, { auth: { authFetch: af } });
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 500');
  });
});

describe('ContextTreeSelector search', () => {
  const roots = [{ id: 'r1', displayName: 'Application catalogue', variant: 'synced', targetType: 'Resource', contextType: 'Catalogue' }];

  it('swaps the tree list for search results while a term is typed, and back', async () => {
    const af = makeAuthFetch({ '/api/contexts?': { data: [PAYROLL] } });
    renderWithProviders(
      <ContextTreeSelector roots={roots} selectedRootId="r1" onSelectRoot={() => {}} onOpenContext={() => {}} loading={false} />,
      { auth: { authFetch: af } },
    );
    expect(screen.getByText('Application catalogue')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'All attributes' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a context' }), { target: { value: 'CI0012345' } });

    expect(await screen.findByText('Payroll')).toBeInTheDocument();
    expect(screen.queryByText('Application catalogue')).toBeNull();
    expect(af).toHaveBeenCalledWith('/api/contexts?search=CI0012345&extendedSearch=true');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a context' }), { target: { value: '' } });
    await waitFor(() => expect(screen.getByText('Application catalogue')).toBeInTheDocument());
  });
});
