// @vitest-environment jsdom
//
// The builder tab end to end, without a model server: the panels it composes, the gate in
// front of it, seeding from a saved context, and what Create sends.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement as h } from 'react';
import ContextBuilderPage from './ContextBuilderPage';
import { renderWithProviders, makeAuthFetch, screen, fireEvent, waitFor } from '@ui/test-utils/renderWithProviders';

const mockCanBuild = vi.fn(() => true);
vi.mock('@ui/hooks/useCanBuildContexts', () => ({ useCanBuildContexts: () => mockCanBuild() }));

const OPTIONS = {
  resourceTypes: ['Group', 'AppRole'],
  fields: [{ name: 'displayName', label: 'Name' }, { name: 'description', label: 'Description' }, { name: 'mail', label: 'Mail address' }],
};
const SAVED = {
  contextId: 'ctx-1',
  question: 'inkoopgroepen',
  recipe: {
    name: 'Inkoopproces', resourceTypes: ['Group'], fields: ['displayName', 'description'],
    terms: [{ text: 'inkoop', key: 'inkoop', match: 'wordStart', state: 'accepted', origin: 'model', own: true }],
    include: [], exclude: [], structure: 'byTerm',
  },
};
const EVALUATION = {
  scopeTotal: 158, memberCount: 2, addedByModel: 0,
  terms: [{ key: 'inkoop', text: 'inkoop', state: 'accepted', hits: 2, unique: 2, byField: { displayName: 2, description: 0 }, tooBroad: false }],
  matches: [{ id: 'g1', displayName: 'SG_Inkoop_Users', status: 'member', hits: [], resourceType: 'Group', systemName: 'EntraID', description: null }],
};

// The status call answers "no model server", so the describe panel stays out of the way:
// the builder must work without one.
const ROUTES = (over = {}) => makeAuthFetch({
  'context-assistant/options': OPTIONS,
  'context-assistant/status': { available: false, reason: 'server-unreachable' },
  'context-assistant/evaluate': EVALUATION,
  'context-assistant/save': { runId: 'r1', contextId: 'ctx-new', membersAdded: 2, membersRemoved: 0 },
  ...over,
});

function mount({ builderId = 'new-1', authFetch = ROUTES(), onOpenDetail = vi.fn(), onClose = vi.fn(), onCacheData = vi.fn() } = {}) {
  renderWithProviders(h(ContextBuilderPage, { builderId, onOpenDetail, onClose, onCacheData }), { auth: { authFetch } });
  return { authFetch, onOpenDetail, onClose, onCacheData };
}

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); mockCanBuild.mockReturnValue(true); });
afterEach(() => vi.useRealTimers());

describe('ContextBuilderPage', () => {
  it('refuses to open when the feature is off or the role may not build contexts', () => {
    mockCanBuild.mockReturnValue(false);
    mount();
    expect(screen.getByText('You cannot build contexts here')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /New context/ })).toBeNull();
  });

  it('opens an empty builder that works without a model server', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: /New context/ })).toBeInTheDocument();
    expect(await screen.findByText(/The local model is not available/)).toBeInTheDocument();
    expect(screen.getByText('No search terms yet. Describe the context above, or type a term.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create context' })).toBeDisabled();
  });

  it('seeds from a saved context, shows what it finds, and offers to open it', async () => {
    const { onOpenDetail } = mount({ builderId: 'ctx-1', authFetch: ROUTES({ 'context-assistant/recipe/': SAVED }) });

    expect(await screen.findByRole('heading', { name: /Edit context/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Inkoopproces'));
    await waitFor(() => expect(screen.getByText('2 objects in the context')).toBeInTheDocument());
    expect(screen.getByText('SG_Inkoop_Users')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open context' }));
    expect(onOpenDetail).toHaveBeenCalledWith('context', 'ctx-1', 'Inkoopproces');
  });

  it('a term typed by hand is searched for, and Create sends the whole recipe', async () => {
    const { authFetch, onCacheData } = mount();
    await screen.findByText(/The local model is not available/);

    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Inkoopproces' } });
    fireEvent.change(screen.getByLabelText('Add a search term'), { target: { value: 'inkoop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add term' }));

    await waitFor(() => expect(screen.getByText('2 objects in the context')).toBeInTheDocument());
    const evaluated = authFetch.mock.calls.filter(([u]) => u.includes('/evaluate'));
    expect(JSON.parse(evaluated.at(-1)[1].body).recipe.terms[0]).toMatchObject({ text: 'inkoop', match: 'wordStart', origin: 'analyst' });

    fireEvent.click(screen.getByRole('button', { name: 'Create context' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Created — 2 objects added.'));
    const saved = JSON.parse(authFetch.mock.calls.find(([u]) => u.includes('/save'))[1].body);
    expect(saved.recipe).toMatchObject({ name: 'Inkoopproces', structure: 'byTerm', resourceTypes: ['Group'] });
    expect(onCacheData).toHaveBeenCalledWith('new-1', 'context-builder', { displayName: 'Inkoopproces' });
  });

  it('says why it cannot be saved yet', async () => {
    mount();
    await screen.findByText(/The local model is not available/);
    expect(screen.getByRole('button', { name: 'Create context' })).toHaveAttribute('title', 'Give the context a name.');

    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Inkoopproces' } });
    expect(screen.getByRole('button', { name: 'Create context' }))
      .toHaveAttribute('title', 'Keep at least one term, or include an object by hand.');
  });

  it('the scope settings change what is searched', async () => {
    const { authFetch } = mount();
    await screen.findByText(/The local model is not available/);
    fireEvent.change(screen.getByLabelText('Add a search term'), { target: { value: 'inkoop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add term' }));
    await waitFor(() => expect(authFetch.mock.calls.some(([u]) => u.includes('/evaluate'))).toBe(true));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Mail address' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'AppRole' }));
    fireEvent.change(screen.getByLabelText('Structure'), { target: { value: 'flat' } });

    await waitFor(() => {
      const last = JSON.parse(authFetch.mock.calls.filter(([u]) => u.includes('/evaluate')).at(-1)[1].body).recipe;
      expect(last.fields).toEqual(['displayName', 'description', 'mail']);
      expect(last.resourceTypes).toEqual(['Group', 'AppRole']);
      expect(last.structure).toBe('flat');
    });
  });
});

// ── Users with access ────────────────────────────────────────────────────────
const USERS_EVALUATION = {
  ...EVALUATION,
  target: 'principal',
  orgMatches: [{ id: 'o1', entityType: 'Klant', label: 'Contoso', termKeys: ['contoso'], linkedPrincipals: 4, state: 'matched' }],
  principals: { total: 250, sample: [{ id: 'u1', displayName: 'Ann Example', upn: null, principalType: 'User', via: [] }] },
  termPrincipals: { contoso: 250 },
};
const READY_MODEL = { 'context-assistant/status': { available: true, loaded: true, promptCache: 'ready' } };
const TERMS_REPLY = (target) => ({
  kind: 'terms', name: 'Users with access to Contoso', notes: [], target,
  terms: [{ text: 'Contoso', key: 'contoso', match: 'wordStart', state: 'accepted', origin: 'model', own: true }],
});

const evaluateBodies = (authFetch) => authFetch.mock.calls.filter(([u]) => u.includes('/evaluate')).map(([, o]) => JSON.parse(o.body));
const lastEvaluated = (authFetch) => evaluateBodies(authFetch).at(-1).recipe;

async function typeTerm(text = 'contoso') {
  await screen.findByRole('radio', { name: 'Resources' });
  fireEvent.change(screen.getByLabelText('Add a search term'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Add term' }));
}

async function describeIt(target) {
  const authFetch = ROUTES({ ...READY_MODEL, 'context-assistant/interpret': TERMS_REPLY(target), 'context-assistant/evaluate': USERS_EVALUATION });
  mount({ authFetch });
  fireEvent.change(await screen.findByRole('textbox', { name: 'Describe the context' }), { target: { value: 'all users with access to Contoso' } });
  fireEvent.click(screen.getByRole('button', { name: 'Propose terms' }));
  await waitFor(() => expect(evaluateBodies(authFetch).length).toBeGreaterThan(0));
  return authFetch;
}

describe('ContextBuilderPage — users with access', () => {
  it('a resource draft is evaluated and saved with exactly the fields it always had', async () => {
    const { authFetch } = mount();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), { target: { value: 'Contoso' } });
    await typeTerm();
    await waitFor(() => expect(screen.getByText('2 objects in the context')).toBeInTheDocument());
    const term = { text: 'contoso', key: 'contoso', match: 'wordStart', state: 'accepted', origin: 'analyst' };
    expect(evaluateBodies(authFetch).at(-1)).toEqual({
      recipe: { resourceTypes: ['Group'], fields: ['displayName', 'description'], terms: [term], include: [], exclude: [], structure: 'byTerm' },
    });
    expect(screen.queryByRole('group', { name: 'Access that counts' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Create context' }));
    await waitFor(() => expect(authFetch.mock.calls.some(([u]) => u.includes('/save'))).toBe(true));
    expect(JSON.parse(authFetch.mock.calls.find(([u]) => u.includes('/save'))[1].body)).toEqual({
      recipe: { name: 'Contoso', resourceTypes: ['Group'], fields: ['displayName', 'description'], terms: [term], include: [], exclude: [], structure: 'byTerm' },
      question: '',
    });
  });

  it('switching to users re-evaluates with the target in the body, and switching back sends the resource draft unchanged', async () => {
    const { authFetch } = mount({ authFetch: ROUTES({ 'context-assistant/evaluate': USERS_EVALUATION }) });
    await typeTerm();
    await waitFor(() => expect(screen.getByText('2 objects in the context')).toBeInTheDocument());
    const resourceBody = JSON.stringify(evaluateBodies(authFetch).at(-1));

    fireEvent.click(screen.getByRole('radio', { name: 'Users with access' }));
    await waitFor(() => expect(lastEvaluated(authFetch).target).toBe('principal'));
    expect(lastEvaluated(authFetch)).toMatchObject({
      access: { assignmentTypes: ['Direct', 'Indirect'] }, orgInclude: [], orgExclude: [], principalInclude: [], principalExclude: [],
    });
    // The header now counts users, not resources.
    await waitFor(() => expect(screen.getByText('250 users in the context')).toBeInTheDocument());
    expect(screen.getByRole('region', { name: 'Resulting users' })).toBeInTheDocument();

    const calls = evaluateBodies(authFetch).length;
    fireEvent.click(screen.getByRole('radio', { name: 'Resources' }));
    await waitFor(() => expect(evaluateBodies(authFetch).length).toBe(calls + 1));
    expect(JSON.stringify(evaluateBodies(authFetch).at(-1))).toBe(resourceBody);
  });

  it('Eligible counts only when ticked', async () => {
    const { authFetch } = mount({ authFetch: ROUTES({ 'context-assistant/evaluate': USERS_EVALUATION }) });
    await typeTerm();
    fireEvent.click(screen.getByRole('radio', { name: 'Users with access' }));
    expect(screen.getByRole('checkbox', { name: 'Eligible (not yet activated)' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Eligible (not yet activated)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Direct' }));
    await waitFor(() => expect(lastEvaluated(authFetch).access).toEqual({ assignmentTypes: ['Indirect', 'Eligible'] }));
  });

  it('organisation entities and users chosen on screen land in their own recipe lists', async () => {
    const { authFetch } = mount({ authFetch: ROUTES({ 'context-assistant/evaluate': USERS_EVALUATION }) });
    await typeTerm();
    fireEvent.click(screen.getByRole('radio', { name: 'Users with access' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Exclude Contoso' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exclude Ann Example' }));
    await waitFor(() => expect(lastEvaluated(authFetch)).toMatchObject({
      orgInclude: [], orgExclude: ['o1'], principalInclude: [], principalExclude: ['u1'], include: [], exclude: [],
    }));
  });

  it('the model reading "users with access" preselects the users target, and Create saves the users recipe', async () => {
    const authFetch = await describeIt('principal');
    expect(screen.getByRole('radio', { name: 'Users with access' })).toBeChecked();
    expect(lastEvaluated(authFetch)).toMatchObject({ target: 'principal', terms: [{ key: 'contoso' }] });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Users with access to Contoso'));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Create context' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Create context' }));
    await waitFor(() => expect(authFetch.mock.calls.some(([u]) => u.includes('/save'))).toBe(true));
    const saved = JSON.parse(authFetch.mock.calls.find(([u]) => u.includes('/save'))[1].body);
    expect(saved.question).toBe('all users with access to Contoso');
    expect(saved.recipe).toMatchObject({
      name: 'Users with access to Contoso', target: 'principal', access: { assignmentTypes: ['Direct', 'Indirect'] },
      orgInclude: [], orgExclude: [], principalInclude: [], principalExclude: [],
    });
  });

  it('a resource reading of the description leaves the draft a resource draft, with no target field', async () => {
    const authFetch = await describeIt('resource');
    expect(screen.getByRole('radio', { name: 'Resources' })).toBeChecked();
    expect(Object.keys(lastEvaluated(authFetch)).sort()).toEqual(['exclude', 'fields', 'include', 'resourceTypes', 'structure', 'terms']);
  });
});
