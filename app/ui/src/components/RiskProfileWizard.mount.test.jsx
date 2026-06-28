// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import RiskProfileWizard from './RiskProfileWizard';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, fireEvent, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const llmReady = { configured: true };
const generatedProfile = { name: 'Acme Risk Profile', industry: 'Healthcare', regulations: ['HIPAA'] };
const generatedClassifiers = { patterns: [{ name: 'admin', regex: 'admin' }] };

// authFetch routes for a fully-configured LLM. Most-specific URL substrings first.
function routes(overrides = {}) {
  return makeAuthFetch({
    '/api/admin/llm/status': llmReady,
    '/api/risk-profiles/scraper-credentials': [{ id: 'cred1', label: 'Wiki creds' }],
    '/api/risk-profiles/generate': { profile: generatedProfile, llmModel: 'claude-opus', scraped: [] },
    '/api/risk-profiles/refine': { assistantMessage: 'Dropped NIS2.', profile: generatedProfile, llmModel: 'claude-opus' },
    '/api/risk-profiles': { id: 'prof-1' },
    '/api/risk-classifiers/generate': { classifiers: generatedClassifiers },
    '/api/risk-classifiers': { id: 'clf-1' },
    '/api/risk-scoring/runs': { id: 'run-1', status: 'running', pct: 0 },
    ...overrides,
  });
}

function mount(authFetch = routes(), props = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const result = renderWithProviders(
    h(RiskProfileWizard, { onClose, onSaved, ...props }),
    { auth: { authFetch } },
  );
  return { ...result, onClose, onSaved, authFetch };
}

// Walks step 1 → 2 → 3 → 4 (classifiers generated). Returns the test handles.
async function reachClassifiers(authFetch = routes()) {
  const handles = mount(authFetch);
  const user = userEvent.setup();

  // Step 1: fill domain, generate.
  await user.type(await screen.findByPlaceholderText('example.com'), 'acme.com');
  await user.click(screen.getByText('Generate profile →'));

  // Step 2: refine.
  await screen.findByText('Refine the profile');
  await user.click(screen.getByText('Looks good — save →'));

  // Step 3: save profile.
  await screen.findByText('Save profile');
  await user.click(screen.getByText('Save profile →'));

  // Step 4: classifiers. (The heading and the button share the text, so
  // target the button by role.)
  await screen.findByRole('button', { name: 'Generate classifiers' });
  await user.click(screen.getByRole('button', { name: 'Generate classifiers' }));
  await screen.findByText('Save classifiers →');
  return { ...handles, user };
}

describe('RiskProfileWizard (mounted)', () => {
  it('shows a loading state until the LLM status resolves', () => {
    // Never-resolving status fetch keeps llmReady === null.
    const authFetch = vi.fn(() => new Promise(() => {}));
    mount(authFetch);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('warns when no LLM provider is configured', async () => {
    const authFetch = makeAuthFetch({
      '/api/admin/llm/status': { configured: false },
      '/api/risk-profiles/scraper-credentials': [],
    });
    mount(authFetch);
    expect(await screen.findByText(/No LLM provider is configured yet/i)).toBeInTheDocument();
  });

  it('renders the sources step and supports add/edit/remove URL rows', async () => {
    mount();
    const user = userEvent.setup();

    expect(await screen.findByText('Tell us about the organisation')).toBeInTheDocument();

    // Fill the basic fields.
    await user.type(screen.getByPlaceholderText('example.com'), 'acme.com');
    await user.type(screen.getByPlaceholderText('Acme Corp'), 'Acme Corp');
    await user.type(screen.getByPlaceholderText(/medical-device division/i), 'focus on EU');

    // Add a URL row; the credential dropdown is populated from the mount fetch.
    await user.click(screen.getByText('+ Add URL'));
    const urlInput = screen.getByPlaceholderText('https://wiki.internal/about');
    await user.type(urlInput, 'https://wiki.internal/about');
    fireEvent.change(screen.getByDisplayValue('no auth'), { target: { value: 'cred1' } });
    expect(await screen.findByText('Wiki creds')).toBeInTheDocument();

    // Remove the row.
    await user.click(screen.getByText('×', { selector: 'button.text-red-600' }));
    expect(screen.queryByPlaceholderText('https://wiki.internal/about')).not.toBeInTheDocument();
  });

  it('cancels via the footer button', async () => {
    const { onClose } = mount();
    const user = userEvent.setup();
    await user.click(await screen.findByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('surfaces a generate error and stays on the sources step', async () => {
    const authFetch = routes({
      '/api/risk-profiles/generate': jsonResponse({ error: 'LLM exploded' }, { ok: false, status: 500 }),
    });
    mount(authFetch);
    const user = userEvent.setup();

    await user.type(await screen.findByPlaceholderText('example.com'), 'acme.com');
    await user.click(screen.getByText('Generate profile →'));

    expect(await screen.findByText('LLM exploded')).toBeInTheDocument();
    expect(screen.getByText('Tell us about the organisation')).toBeInTheDocument();
  });

  it('generates a profile and advances to the refine step, then refines via chat', async () => {
    const authFetch = routes();
    mount(authFetch);
    const user = userEvent.setup();

    await user.type(await screen.findByPlaceholderText('example.com'), 'acme.com');
    await user.click(screen.getByText('Generate profile →'));

    // Step 2 shows the model and the generated profile JSON.
    expect(await screen.findByText('Refine the profile')).toBeInTheDocument();
    expect(screen.getByText('claude-opus')).toBeInTheDocument();

    // Refinement chat round-trip.
    await user.type(screen.getByPlaceholderText(/Ask for a change/i), 'drop NIS2');
    await user.click(screen.getByText('Send'));

    expect(await screen.findByText('Dropped NIS2.')).toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledWith(
      '/api/risk-profiles/refine',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('saves the profile (POST /api/risk-profiles) and advances to classifiers', async () => {
    const authFetch = routes();
    mount(authFetch);
    const user = userEvent.setup();

    await user.type(await screen.findByPlaceholderText('example.com'), 'acme.com');
    await user.click(screen.getByText('Generate profile →'));
    await user.click(await screen.findByText('Looks good — save →'));

    // Step 3 — name was pre-filled from the generated profile.
    expect(await screen.findByText('Save profile')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Acme Risk Profile')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox')); // toggle makeActive
    await user.click(screen.getByText('Save profile →'));

    expect(await screen.findByText(/Classifiers are regex patterns/i)).toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledWith(
      '/api/risk-profiles',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('generates and saves classifiers, advancing to the scoring step', async () => {
    const authFetch = routes();
    const { user } = await reachClassifiers(authFetch);

    expect(authFetch).toHaveBeenCalledWith(
      '/api/risk-classifiers/generate',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.getByDisplayValue('Acme Risk Profile classifiers')).toBeInTheDocument();

    await user.click(screen.getByText('Save classifiers →'));

    expect(await screen.findByText('Run scoring')).toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledWith(
      '/api/risk-classifiers',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('skips classifiers via "Skip — done for now"', async () => {
    const authFetch = routes();
    const handles = mount(authFetch);
    const user = userEvent.setup();

    await user.type(await screen.findByPlaceholderText('example.com'), 'acme.com');
    await user.click(screen.getByText('Generate profile →'));
    await user.click(await screen.findByText('Looks good — save →'));
    await user.click(await screen.findByText('Save profile →'));
    await user.click(await screen.findByText('Skip — done for now'));

    expect(handles.onSaved).toHaveBeenCalled();
    expect(handles.onClose).toHaveBeenCalled();
  });

  it('starts scoring, polls progress, and completes', async () => {
    vi.useFakeTimers();
    try {
      // First runs POST returns running; the poll GET returns completed.
      const authFetch = makeAuthFetch((url, opts = {}) => {
        if (url.includes('/api/admin/llm/status')) return llmReady;
        if (url.includes('/api/risk-profiles/scraper-credentials')) return [];
        if (url.includes('/api/risk-profiles/generate')) return { profile: generatedProfile, llmModel: 'm', scraped: [] };
        if (url.includes('/api/risk-profiles')) return { id: 'prof-1' };
        if (url.includes('/api/risk-classifiers/generate')) return { classifiers: generatedClassifiers };
        if (url.includes('/api/risk-classifiers')) return { id: 'clf-1' };
        if (url.includes('/api/risk-scoring/runs/run-1')) return { id: 'run-1', status: 'completed', pct: 100, scoredEntities: 5, totalEntities: 5 };
        if (url.includes('/api/risk-scoring/runs') && opts.method === 'POST') return { id: 'run-1', status: 'running', pct: 0 };
        return undefined;
      });

      mount(authFetch);
      // Drive the wizard with fake timers active — userEvent needs the real
      // timer advance hook, so use fireEvent for determinism here.
      await vi.waitFor(() => screen.getByPlaceholderText('example.com'));
      fireEvent.change(screen.getByPlaceholderText('example.com'), { target: { value: 'acme.com' } });
      fireEvent.click(screen.getByText('Generate profile →'));
      await vi.waitFor(() => screen.getByText('Looks good — save →'));
      fireEvent.click(screen.getByText('Looks good — save →'));
      await vi.waitFor(() => screen.getByText('Save profile →'));
      fireEvent.click(screen.getByText('Save profile →'));
      await vi.waitFor(() => screen.getByRole('button', { name: 'Generate classifiers' }));
      fireEvent.click(screen.getByRole('button', { name: 'Generate classifiers' }));
      await vi.waitFor(() => screen.getByText('Save classifiers →'));
      fireEvent.click(screen.getByText('Save classifiers →'));
      await vi.waitFor(() => screen.getByText('Run scoring now'));

      fireEvent.click(screen.getByText('Run scoring now'));
      await vi.waitFor(() => screen.getByText('running'));

      // Advance the 2s poll interval; the GET resolves to completed.
      await vi.advanceTimersByTimeAsync(2100);
      await vi.waitFor(() => screen.getByText('completed'));
      expect(screen.getByText('5 / 5 entities')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a scoring error when the run request fails', async () => {
    const authFetch = routes({
      '/api/risk-scoring/runs': jsonResponse({ error: 'no classifier' }, { ok: false, status: 400 }),
    });
    const { user } = await reachClassifiers(authFetch);
    await user.click(screen.getByText('Save classifiers →'));
    await user.click(await screen.findByText('Run scoring now'));
    expect(await screen.findByText('no classifier')).toBeInTheDocument();
  });

  it('surfaces a classifier generation error', async () => {
    const authFetch = routes({
      '/api/risk-classifiers/generate': jsonResponse({ error: 'classifier boom' }, { ok: false, status: 500 }),
    });
    mount(authFetch);
    const user = userEvent.setup();

    await user.type(await screen.findByPlaceholderText('example.com'), 'acme.com');
    await user.click(screen.getByText('Generate profile →'));
    await user.click(await screen.findByText('Looks good — save →'));
    await user.click(await screen.findByText('Save profile →'));
    await user.click(await screen.findByRole('button', { name: 'Generate classifiers' }));

    await waitFor(() => expect(screen.getByText('classifier boom')).toBeInTheDocument());
  });

  it('navigates back from the save step to the refine step', async () => {
    mount();
    const user = userEvent.setup();

    await user.type(await screen.findByPlaceholderText('example.com'), 'acme.com');
    await user.click(screen.getByText('Generate profile →'));
    await user.click(await screen.findByText('Looks good — save →'));
    await user.click(await screen.findByText('← Back'));

    expect(await screen.findByText('Refine the profile')).toBeInTheDocument();
  });
});
