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

  it('says which name the rivals share, at the level the match rested on', async () => {
    // Two holds, two different findings: one rival is spelled the account's full
    // name, the other only shares its surname and first initial. One sentence for
    // both reads as "these people answer to this name", which is false of the
    // second and sends the analyst looking for a namesake who does not exist.
    mount([{ status: 'completed', nameOnlyMatches: 2, nameOnlySuggestions: [
      ambiguous({
        principalId: 'p-exact', displayName: 'Youssef El Mahdi', matchLevel: 'full',
        rivals: [{ identityId: 'i9', identityName: 'Youssef El Mahdi' }],
      }),
      ambiguous({
        principalId: 'p-initial', displayName: 'Youri El Mahdi', matchLevel: 'surnameInitial',
        rivals: [{ identityId: 'i2', identityName: 'Yassin El Mahdi' }],
      }),
    ] }]);

    const exact = (await screen.findByText('Youssef El Mahdi')).closest('tr');
    expect(within(exact).getByText(/full name also answered to by Youssef El Mahdi/i)).toBeInTheDocument();
    const initial = screen.getByText('Youri El Mahdi').closest('tr');
    expect(within(initial).getByText(/surname and first initial also shared by Yassin El Mahdi/i))
      .toBeInTheDocument();
  });

  it('distinguishes a hold on the whole initials sequence from one on the first letter', async () => {
    // A third finding, and the one #1455 adds: the rivals state the account's
    // WHOLE sequence of initials (`Buskes, L.R.`), not merely its first letter.
    // Rendered with the first-initial wording an analyst reads it as a near-miss
    // and looks for the difference the second letter would have shown — there is
    // none, which is exactly why the match is held.
    mount([{ status: 'completed', nameOnlyMatches: 2, nameOnlySuggestions: [
      ambiguous({
        principalId: 'p-initials', displayName: 'Buskes, L.R.', matchLevel: 'surnameInitials',
        rivals: [{ identityId: 'i3', identityName: 'Laura Rosa Buskes' }],
      }),
      ambiguous({
        principalId: 'p-one', displayName: 'Jansen, J.', matchLevel: 'surnameInitial',
        rivals: [{ identityId: 'i4', identityName: 'Johannes Jansen' }],
      }),
    ] }]);

    const initials = (await screen.findByText('Buskes, L.R.')).closest('tr');
    expect(within(initials).getByText(/surname and initials also shared by Laura Rosa Buskes/i))
      .toBeInTheDocument();
    // The paired row, so the two wordings are actually told apart rather than
    // both matching the looser phrase.
    const one = screen.getByText('Jansen, J.').closest('tr');
    expect(within(one).getByText(/surname and first initial also shared by Johannes Jansen/i))
      .toBeInTheDocument();
  });

  it('keeps the old wording for a stored run that predates the matched level', async () => {
    // A run stored before the field existed cannot say which name was shared, and
    // guessing "full name" for it would be a claim the run never made.
    mount([{ status: 'completed', nameOnlyMatches: 1, nameOnlySuggestions: [ambiguous()] }]);

    expect(await screen.findByText(/^name also answered to by Johanna Doe$/i)).toBeInTheDocument();
  });

  it('says the number is why, for a login held with no rival at all', async () => {
    // `adm-skleef2` beside the `skleef` mailbox: the login spells her name, so she is
    // the matched identity, but the number says the account is not hers and nobody
    // else answers to the form. Rendered as an ambiguity — the fallback every unknown
    // reason lands on — it would read as "no second signal", which is the one thing
    // this hold is not: there IS no second person to pick, and the row would give the
    // reviewer nothing to go on.
    mount([{ status: 'completed', nameOnlyMatches: 1, nameOnlySuggestions: [suggestion({
      displayName: 'Admin account 134', identityName: 'Sophie van Kleef',
      signals: ['loginNameForm'], confidence: 55, reason: 'numberedLogin', matchLevel: 'loginName',
    })] }]);

    const row = (await screen.findByText('Admin account 134')).closest('tr');
    expect(within(row).getByText(/un-numbered form is this person’s own address/i)).toBeInTheDocument();
    expect(within(row).queryByText(/no second signal/i)).not.toBeInTheDocument();
    expect(within(row).queryByText(/answered to by/i)).not.toBeInTheDocument();
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
