// @vitest-environment jsdom
//
// The read-only list of matches account linking refused to make on a name alone.
//
// Most of what can go wrong here is a wrong-but-plausible render: showing the empty state
// for a run that did hold matches back, claiming "nothing held back" for a run that
// predates the feature and never looked, or silently showing 500 of 3,000 as if that were
// all of them. Each case below picks inputs that tell those apart.

import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import NameOnlyMatchesCard from './NameOnlyMatchesCard';
import {
  renderWithProviders, makeAuthFetch, jsonResponse, screen, within,
} from '@ui/test-utils/renderWithProviders';

const suggestion = (over = {}) => ({
  principalId: 'p1', displayName: 'Doe, John (OGD)', identityId: 'i1', identityName: 'John Doe',
  confidence: 60, signals: ['fullName'], accountType: 'Secondary', ties: 1, ...over,
});

const runsFetch = (runs) => makeAuthFetch({ '/api/account-linking/runs': { data: runs } });

function mount(runs) {
  return renderWithProviders(h(NameOnlyMatchesCard), { auth: { authFetch: runsFetch(runs) } });
}

describe('NameOnlyMatchesCard (mounted)', () => {
  it('lists the account, the identity it nearly linked to, and the evidence', async () => {
    mount([{ status: 'completed', nameOnlyMatches: 1, nameOnlySuggestions: [suggestion()] }]);

    const row = within(await screen.findByRole('table', { name: /Name-only matches held for review/i })
    ).getByText('Doe, John (OGD)').closest('tr');
    expect(within(row).getByText('John Doe')).toBeInTheDocument();
    expect(within(row).getByText('60%')).toBeInTheDocument();
    expect(within(row).getByText('fullName')).toBeInTheDocument();
    expect(within(row).getByText('Secondary')).toBeInTheDocument();
  });

  it('marks a match that tied across identities, and only that one', async () => {
    mount([{ status: 'completed', nameOnlyMatches: 2, nameOnlySuggestions: [
      suggestion({ principalId: 'p-tied', displayName: 'Jansen, Jan', ties: 2 }),
      suggestion({ principalId: 'p-single', displayName: 'Doe, John (OGD)', ties: 1 }),
    ] }]);

    const tied = (await screen.findByText('Jansen, Jan')).closest('tr');
    expect(within(tied).getByText('2 candidates tied')).toBeInTheDocument();
    const single = screen.getByText('Doe, John (OGD)').closest('tr');
    expect(within(single).queryByText(/candidates tied/i)).not.toBeInTheDocument();
  });

  it('falls back to the raw ids when a name was not recorded', async () => {
    mount([{ status: 'completed', nameOnlyMatches: 1, nameOnlySuggestions: [
      suggestion({ displayName: null, identityName: null, accountType: null, signals: null }),
    ] }]);

    expect(await screen.findByText('p1')).toBeInTheDocument();
    expect(screen.getByText('i1')).toBeInTheDocument();
  });

  it('says the list is capped rather than presenting it as complete', async () => {
    // `nameOnlyMatches` is the true count and the list is capped, so 3 of 1200 must read
    // as a sample. Silently showing 3 would report the tenant as nearly clean.
    mount([{
      status: 'completed', nameOnlyMatches: 1200,
      nameOnlySuggestions: [suggestion(), suggestion({ principalId: 'p2' }), suggestion({ principalId: 'p3' })],
    }]);

    expect(await screen.findByText(/Showing 3 of 1200 — 1197 more were held back but not listed/i))
      .toBeInTheDocument();
  });

  it('does not claim a cap when the whole list is shown', async () => {
    mount([{ status: 'completed', nameOnlyMatches: 1, nameOnlySuggestions: [suggestion()] }]);

    await screen.findByText('Doe, John (OGD)');
    expect(screen.queryByText(/more were held back/i)).not.toBeInTheDocument();
  });

  it('distinguishes "the run held nothing back" from "no run has reported yet"', async () => {
    const { unmount } = mount([{ status: 'completed', nameOnlyMatches: 0, nameOnlySuggestions: [] }]);
    expect(await screen.findByText(/held nothing back/i)).toBeInTheDocument();
    unmount();

    mount([{ status: 'completed', nameOnlySuggestions: null }]);
    expect(await screen.findByText(/No completed run has reported name-only matches yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/held nothing back/i)).not.toBeInTheDocument();
  });

  it('reports a failed read instead of an empty list', async () => {
    const authFetch = makeAuthFetch(() => jsonResponse({ error: 'nope' }, { ok: false, status: 500 }));
    renderWithProviders(h(NameOnlyMatchesCard), { auth: { authFetch } });

    expect(await screen.findByText(/Could not load the last run \(HTTP 500\)/i)).toBeInTheDocument();
    expect(screen.queryByText(/held nothing back/i)).not.toBeInTheDocument();
  });
});
