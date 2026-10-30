// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import CandidatePanel from './CandidatePanel';
import { renderWithProviders, screen } from '@ui/test-utils/renderWithProviders';

const data = { people: [], columns: [], unit: { displayName: 'Claims', accountable: null } };
const role = (over) => ({
  id: 'draft:1', name: 'Lawyer', description: '', baseBusinessRoleId: null, members: new Set(), handMembers: new Set(), entitlements: new Set(['r1']),
  kind: 'requestable', rule: null, excluded: new Set(), joinerPolicy: 'auto', leaverPolicy: 'remove', approver: null, rationale: '', ...over,
});
const draft = (candidate) => ({ selection: new Set(), marks: new Map(), drafts: [candidate], activeId: candidate.id, viewRoleId: null, nextId: 2 });

function mount(candidate, roleActions) {
  const props = { draft: draft(candidate), dispatch: vi.fn(), data, cellIndex: new Map(), cellsByResource: new Map(), peopleByKey: new Map(), columnsById: new Map(), candidate, roleActions };
  return renderWithProviders(h(CandidatePanel, props));
}

describe('CandidatePanel — the role\u2019s actions', () => {
  it('shows nothing extra without actions to offer', () => {
    mount(role({ name: '' }));
    expect(screen.queryByRole('list', { name: 'Before saving' })).toBeNull();
  });

  it('lists what the role still needs above its actions, and hands them the problems', () => {
    const actions = vi.fn(() => h('button', null, 'Save role'));
    mount(role({ name: '', entitlements: new Set() }), actions);
    expect(screen.getByRole('list', { name: 'Before saving' })).toHaveTextContent('Give the role a name.Add at least one entitlement');
    expect(screen.getByRole('button', { name: 'Save role' })).toBeInTheDocument();
    expect(actions.mock.calls[0][0].problems).toHaveLength(2);
    // The actions sit above Remove.
    const [save, remove] = [screen.getByRole('button', { name: 'Save role' }), screen.getByRole('button', { name: 'Remove this proposed role' })];
    expect(save.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('notes a rule-based role without a rule, without blocking it', () => {
    mount(role({ kind: 'rule' }), () => null);
    expect(screen.queryByRole('list', { name: 'Before saving' })).toBeNull();
    expect(screen.getByText('It will be saved with members chosen by hand — it has no assignment rule yet.')).toBeInTheDocument();
  });
});
