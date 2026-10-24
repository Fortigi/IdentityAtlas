// @vitest-environment jsdom
//
// The match table is where the analyst checks the result before saving: what is in, what
// was kept out, what a dropped term would add — and why each object is there.
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import MatchesPanel from './MatchesPanel';
import { renderWithProviders, makeAuthFetch, screen, fireEvent, waitFor } from '@ui/test-utils/renderWithProviders';

const FIELD_LABELS = { displayName: 'Name', description: 'Description', mail: 'Mail address' };
const RECIPE = { name: 'Inkoop', resourceTypes: ['Group'], fields: ['displayName'], terms: [], include: [], exclude: [], structure: 'byTerm' };

const match = (id, displayName, status, hits = []) => ({
  id, displayName, status, hits, description: null, resourceType: 'Group', systemName: 'EntraID',
});

const EVALUATION = {
  scopeTotal: 158,
  memberCount: 2,
  matches: [
    match('g1', 'SG_Inkoop_Users', 'member', [{ term: 'inkoop', fields: ['displayName'], accepted: true }]),
    match('g2', 'Coupa Admins', 'included'),
    match('g3', 'Zorg Planning', 'excluded', [{ term: 'zorg', fields: ['displayName'], accepted: true }]),
    match('g4', 'Order Intake', 'candidate', [{ term: 'order', fields: ['description'], accepted: false }]),
  ],
};

function mount({ evaluation = EVALUATION, recipe = RECIPE, lookup = [] } = {}) {
  const onChoose = vi.fn();
  const onOpenDetail = vi.fn();
  renderWithProviders(
    h(MatchesPanel, { evaluation, recipe, fieldLabels: FIELD_LABELS, onChoose, onOpenDetail }),
    { auth: { authFetch: makeAuthFetch({ '/lookup': { data: lookup } }) } },
  );
  return { onChoose, onOpenDetail };
}

describe('MatchesPanel', () => {
  it('opens on what is in the context, counts each view, and says how big the scope is', () => {
    mount();
    expect(screen.getByRole('tab', { name: 'In the context (2)' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Excluded (1)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Found only by dropped terms (1)' })).toBeInTheDocument();
    expect(screen.getByText('of 158 group objects in scope')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'SG_Inkoop_Users' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Zorg Planning' })).toBeNull();
  });

  it('shows why an object is in it: the term that found it, and the field when it was not the name', () => {
    mount();
    expect(screen.getByText('inkoop')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Found only by dropped terms (1)' }));
    expect(screen.getByText('order (description)')).toBeInTheDocument();
  });

  it('offers the opposite action per row, and reports the analyst\'s choice', () => {
    const { onChoose } = mount();
    fireEvent.click(screen.getAllByRole('button', { name: 'Exclude' })[0]);
    expect(onChoose).toHaveBeenCalledWith('g1', 'exclude');

    // An object added by hand is removed again, not excluded.
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onChoose).toHaveBeenCalledWith('g2', 'auto');

    fireEvent.click(screen.getByRole('tab', { name: 'Excluded (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Put back' }));
    expect(onChoose).toHaveBeenCalledWith('g3', 'auto');
  });

  it('opens the object itself when its name is clicked', () => {
    const { onOpenDetail } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'SG_Inkoop_Users' }));
    expect(onOpenDetail).toHaveBeenCalledWith('resource', 'g1', 'SG_Inkoop_Users');
  });

  it('includes an object by name, and offers only kinds the context searches', async () => {
    const { onChoose } = mount({ lookup: [
      { id: 'g9', name: 'Ariba Approvers', type: 'Group' },
      { id: 'a1', name: 'Ariba App Role', type: 'AppRole' },   // out of scope
    ] });
    fireEvent.change(screen.getByLabelText('Find an object to include by hand'), { target: { value: 'ariba' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));

    await waitFor(() => expect(screen.getByText('Ariba Approvers')).toBeInTheDocument());
    expect(screen.queryByText('Ariba App Role')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Include' }));
    expect(onChoose).toHaveBeenCalledWith('g9', 'include');
  });

  it('says when a view is empty, and when there was more than it could show', () => {
    mount({ evaluation: { ...EVALUATION, matches: [], truncated: true } });
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
    expect(screen.getByText(/More objects matched than can be shown/)).toBeInTheDocument();
  });
});
