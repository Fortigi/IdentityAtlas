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
  confidence: 60, signals: ['fullName'], accountType: 'Secondary',
  reason: 'uncorroborated', rivals: [], rivalCount: 0, ...over,
});

/** A match held because a second person answers to the same name. */
const ambiguous = (over = {}) => suggestion({
  reason: 'ambiguousName',
  rivals: [{ identityId: 'i2', identityName: 'Johanna Doe' }],
  rivalCount: 1,
  ...over,
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

  it('names who else answers to the name, and only for the match that was shared', async () => {
    // The two reasons need telling apart: one needs an analyst to pick the right person,
    // the other only exists because this tenant asks every link for a second signal.
    mount([{ status: 'completed', nameOnlyMatches: 2, nameOnlySuggestions: [
      ambiguous({ principalId: 'p-shared', displayName: 'Jansen, Jan' }),
      suggestion({ principalId: 'p-single', displayName: 'Doe, John (OGD)' }),
    ] }]);

    const shared = (await screen.findByText('Jansen, Jan')).closest('tr');
    expect(within(shared).getByText(/name also answered to by Johanna Doe/i)).toBeInTheDocument();
    const single = screen.getByText('Doe, John (OGD)').closest('tr');
    expect(within(single).queryByText(/also answered to by/i)).not.toBeInTheDocument();
    expect(within(single).getByText('no second signal')).toBeInTheDocument();
  });

  it('counts the rivals it did not name', async () => {
    // The stored rival list is capped. Showing only the two it holds would report a
    // four-way namesake as a straight choice between two people.
    mount([{ status: 'completed', nameOnlyMatches: 1, nameOnlySuggestions: [ambiguous({
      rivals: [{ identityId: 'i2', identityName: 'Johanna Doe' }, { identityId: 'i3', identityName: 'Jo Doe' }],
      rivalCount: 4,
    })] }]);

    expect(await screen.findByText(/Johanna Doe, Jo Doe and 2 more/i)).toBeInTheDocument();
  });

  it('falls back to the raw ids when a name was not recorded', async () => {
    mount([{ status: 'completed', nameOnlyMatches: 1, nameOnlySuggestions: [
      ambiguous({
        displayName: null, identityName: null, accountType: null, signals: null,
        rivals: [{ identityId: 'i2' }],
      }),
    ] }]);

    expect(await screen.findByText('p1')).toBeInTheDocument();
    expect(screen.getByText('i1')).toBeInTheDocument();
    expect(screen.getByText(/name also answered to by i2/i)).toBeInTheDocument();
  });

  it('still says the name was shared when the rivals were not recorded at all', async () => {
    // A run from an older build, or a cap of zero: the reason is the finding, so the row
    // must not fall back to reading as "no second signal".
    mount([{ status: 'completed', nameOnlyMatches: 1, nameOnlySuggestions: [
      ambiguous({ rivals: null, rivalCount: null }),
    ] }]);

    expect(await screen.findByText(/name also answered to by another identity/i)).toBeInTheDocument();
    expect(screen.queryByText(/and \d+ more/i)).not.toBeInTheDocument();
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
