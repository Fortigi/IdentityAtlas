// @vitest-environment jsdom
//
// The terms panel is where the analyst decides what the context searches for, so what it
// SHOWS per term is the feature: how much each term finds, how much only it finds, and
// whether the model's suggestions have widened the context.
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import TermsPanel from './TermsPanel';
import { renderWithProviders, makeAuthFetch, screen, fireEvent } from '@ui/test-utils/renderWithProviders';

const FIELD_LABELS = { displayName: 'Name', description: 'Description', mail: 'Mail address' };

const recipe = (terms) => ({
  name: 'Inkoop', resourceTypes: ['Group'], fields: ['displayName', 'description'],
  terms, include: [], exclude: [], structure: 'byTerm',
});

const stat = (key, over = {}) => ({
  key, text: key, match: 'wordStart', state: 'accepted',
  hits: 0, unique: 0, byField: { displayName: 0, description: 0 }, tooBroad: false, ...over,
});

function mount({ terms, stats = [], evaluation, memberCount = 5 } = {}) {
  const actions = { toggle: vi.fn(), match: vi.fn(), remove: vi.fn(), add: vi.fn(), addRelated: vi.fn() };
  renderWithProviders(
    h(TermsPanel, { recipe: recipe(terms), stats, evaluation, fieldLabels: FIELD_LABELS, actions, memberCount }),
    { auth: { authFetch: makeAuthFetch({ '/related': { data: [], contextSize: memberCount } }) } },
  );
  return actions;
}

const INKOOP = { text: 'inkoop', key: 'inkoop', match: 'wordStart', state: 'accepted', origin: 'model', own: true, why: 'name' };
const ZORG = { text: 'zorg', key: 'zorg', match: 'wordStart', state: 'rejected', origin: 'model', own: false, why: 'translation' };

describe('TermsPanel', () => {
  it('says what a kept term finds, what only it finds, and in which field', () => {
    mount({ terms: [INKOOP], stats: [stat('inkoop', { hits: 14, unique: 3, byField: { displayName: 12, description: 5 } })] });
    expect(screen.getByText('14 found · 3 only by this term')).toBeInTheDocument();
    expect(screen.getByText('12 in name, 5 in description')).toBeInTheDocument();
  });

  it('reads a dropped term the other way round — what ticking it would add', () => {
    mount({ terms: [ZORG], stats: [stat('zorg', { state: 'rejected', hits: 40, unique: 37 })] });
    expect(screen.getByText('40 found · 37 not found otherwise')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /zorg/ })).not.toBeChecked();
    // A suggestion the analyst never asked for is marked as such.
    expect(screen.getByText('suggested')).toBeInTheDocument();
  });

  it('marks a term that finds nothing, and one that finds far too much', () => {
    mount({ terms: [INKOOP, { ...ZORG, key: 'ink', text: 'ink' }], stats: [stat('inkoop', { hits: 0 }), stat('ink', { hits: 900, tooBroad: true })] });
    expect(screen.getByText('finds nothing')).toBeInTheDocument();
    expect(screen.getByText('very broad')).toBeInTheDocument();
  });

  it('warns when the model\'s suggestions bring in far more than the analyst\'s own words', () => {
    mount({ terms: [INKOOP, ZORG], stats: [], evaluation: { memberCount: 43, addedByModel: 40 } });
    expect(screen.getByRole('alert').textContent)
      .toContain('The terms the model suggested bring in 40 groups; your own words find 3');
  });

  it('stays quiet when the suggestions add little', () => {
    mount({ terms: [INKOOP], stats: [], evaluation: { memberCount: 14, addedByModel: 2 } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ticking, re-matching, removing and adding all reach the builder', () => {
    const actions = mount({ terms: [INKOOP], stats: [stat('inkoop', { hits: 3 })] });

    fireEvent.click(screen.getByRole('checkbox', { name: /inkoop/ }));
    expect(actions.toggle).toHaveBeenCalledWith('inkoop');

    fireEvent.change(screen.getByLabelText(/How .inkoop. matches/), { target: { value: 'token' } });
    expect(actions.match).toHaveBeenCalledWith('inkoop', 'token');

    fireEvent.click(screen.getByRole('button', { name: 'Remove inkoop' }));
    expect(actions.remove).toHaveBeenCalledWith('inkoop');

    fireEvent.change(screen.getByLabelText('Add a search term'), { target: { value: 'coupa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add term' }));
    expect(actions.add).toHaveBeenCalledWith('coupa');
  });

  it('explains which fields decide membership, and counts what is kept', () => {
    mount({ terms: [INKOOP, ZORG] });
    expect(screen.getByText(/1 kept · 1 dropped\./)).toBeInTheDocument();
    expect(screen.getByText(/matches its name or description/)).toBeInTheDocument();
  });

  it('offers related words only once something is in the context', () => {
    mount({ terms: [INKOOP], memberCount: 0 });
    expect(screen.getByRole('button', { name: 'Find related words' })).toBeDisabled();
  });
});
