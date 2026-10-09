// @vitest-environment jsdom
//
// Organisation → Model → Link rules: draw a relation on the canvas, edit and
// remove one, save and link again (exact POST body, run progress, reload),
// the 400 error list, a refused duplicate, renaming an entity type (with and
// without unsaved edits), keyboard selection, and the read-only view.
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent, waitFor, within, fireEvent } from '@ui/test-utils/renderWithProviders';
import LinkRulesEditor from './LinkRulesEditor';

const IMPORTER = { hasWildcard: false, permissions: new Set(['data.read', 'data.write.contexts']) };
const READER = { hasWildcard: false, permissions: new Set(['data.read']) };

const OWNER_RULE = {
  entityType: 'Customer', targetType: 'Principal', via: 'owner', threshold: 50, name: 'Customer → Principal via owner',
  signals: [{ attribute: 'owner', targetField: 'email', type: 'exact', weight: 90 }],
};
const PROFILE = {
  id: 'p1', name: 'Contoso hours', version: 3, lastSourceId: 's1', lastRunStatus: 'completed',
  recipe: {
    version: 1,
    entities: [
      { type: 'Timesheet', nameColumn: 'Code', attributes: [{ column: 'c4', name: 'column4' }] },
      { type: 'Customer', nameColumn: 'Name', attributes: [{ column: 'Owner', name: 'owner' }] },
    ],
  },
  linkRules: [OWNER_RULE],
};
const MODEL = {
  entityTypes: [{ type: 'Timesheet', count: 900 }, { type: 'Customer', count: 40 }],
  systemTypes: [{ targetType: 'Principal', count: 1127 }],
  links: [{ entityType: 'Customer', targetType: 'Principal', via: 'owner', accepted: 30, proposed: 2 }],
  entityLinks: [],
  profiles: [PROFILE],
};

function sequence(...answers) {
  let i = 0;
  return () => answers[Math.min(i++, answers.length - 1)];
}

function render({ auth = IMPORTER, handler } = {}) {
  const authFetch = makeAuthFetch(handler ?? (() => undefined));
  const onRelinked = vi.fn();
  const r = renderWithProviders(<LinkRulesEditor model={MODEL} onRelinked={onRelinked} />,
    { auth: { authFetch, ...auth }, features: { orgTruth: true } });
  return { authFetch, onRelinked, ...r };
}

const button = (name) => screen.getByRole('button', { name });
const list = () => within(screen.getByRole('list', { name: 'Link rules of Contoso hours' }));

describe('LinkRulesEditor', () => {
  it('draws the existing rule as a line with its counts and lists it', () => {
    const { container } = render();
    expect(screen.getByRole('heading', { name: 'Link rules' })).toBeInTheDocument();
    expect(screen.getByText('version 3')).toBeInTheDocument();
    expect(container.querySelector('[data-line="0"]')).not.toBeNull();
    expect(button('Edit link Customer owner to Account email')).toHaveTextContent('exact 90 · 30 accepted · 2 proposed');
    expect(list().getByText('Customer · owner → Principal')).toBeInTheDocument();
    expect(list().getByText('threshold 50')).toBeInTheDocument();
    expect(button('Save and link again')).toBeDisabled();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('adds Timesheet · column4 → Customer, saves the full list and links again, then reloads', async () => {
    const run = sequence({ id: 'r1', status: 'running', step: 'link', pct: 40 }, { id: 'r1', status: 'completed', stats: { links: { linked: 850, proposed: 12 } } });
    const { authFetch, onRelinked } = render({ handler: (url, opts) => {
      if (url === '/api/org-truth/profiles/p1/relink' && opts.method === 'POST') {
        return jsonResponse({ profile: { id: 'p2' }, run: { id: 'r1', status: 'queued' } }, { status: 202 });
      }
      if (url === '/api/org-truth/runs/r1') return run();
      return undefined;
    } });

    await userEvent.click(button('column4 on Timesheet'));
    expect(button('column4 on Timesheet')).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(button('Link Timesheet column4 to Customer name'));
    const dialog = within(screen.getByRole('dialog', { name: 'New link' }));
    expect(dialog.getByText('New link: Timesheet · column4 → Customer')).toBeInTheDocument();
    expect(dialog.getByRole('combobox', { name: 'Match type 1' })).toHaveValue('fuzzy');
    expect(dialog.getByRole('spinbutton', { name: 'Weight 1' })).toHaveValue(100);
    expect(dialog.getByRole('spinbutton', { name: 'Threshold' })).toHaveValue(60);
    await userEvent.click(dialog.getByRole('button', { name: 'Add' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(list().getByText('Timesheet · column4 → Customer')).toBeInTheDocument();
    expect(button('Edit link Timesheet column4 to Customer name')).toHaveTextContent('fuzzy 100');

    await userEvent.click(button('Save and link again'));
    const post = authFetch.mock.calls.find(([u]) => u.endsWith('/relink'));
    expect(JSON.parse(post[1].body)).toEqual({ linkRules: [
      OWNER_RULE,
      { entityType: 'Timesheet', targetType: 'OrgEntity', via: 'column4', targetEntityType: 'Customer', threshold: 60,
        signals: [{ attribute: 'column4', targetField: 'displayName', type: 'fuzzy', weight: 100 }] },
    ] });
    expect(await screen.findByText('Linking again… queued')).toBeInTheDocument();
    expect(button('Save and link again')).toBeDisabled();
    expect(await screen.findByText('Linking again… link (40%)', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(await screen.findByText('Linked again: 850 linked, 12 proposed for review.', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(onRelinked).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  }, 10000);

  it('shows the 400 error and every reason, and keeps the edits', async () => {
    render({ handler: (url) => (url.endsWith('/relink')
      ? jsonResponse({ error: 'The link rules are not valid.', errors: ['Link rule 2 uses attribute "x".', 'Link rule 2 needs a signal.'] }, { ok: false, status: 400 })
      : undefined) });
    await userEvent.click(button('Remove Customer · owner → Principal'));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(list).toThrow();
    expect(screen.getByText('No link rules yet.')).toBeInTheDocument();
    await userEvent.click(button('Save and link again'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The link rules are not valid.');
    expect(within(alert).getAllByRole('listitem').map(li => li.textContent))
      .toEqual(['Link rule 2 uses attribute "x".', 'Link rule 2 needs a signal.']);
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('edits a line: weight and threshold, a second signal, and saves into the list', async () => {
    render();
    await userEvent.click(button('Edit link Customer owner to Account email'));
    const dialog = within(screen.getByRole('dialog', { name: 'Edit link' }));
    const weight = dialog.getByRole('spinbutton', { name: 'Weight 1' });
    fireEvent.change(weight, { target: { value: '70' } });
    fireEvent.change(dialog.getByRole('spinbutton', { name: 'Threshold' }), { target: { value: '65' } });
    expect(dialog.getByRole('button', { name: 'Remove signal 1' })).toBeDisabled();
    await userEvent.click(dialog.getByRole('button', { name: 'Add signal' }));
    await userEvent.selectOptions(dialog.getByRole('combobox', { name: 'Match type 2' }), 'prefix');
    await userEvent.click(dialog.getByRole('button', { name: 'Save' }));
    expect(list().getByText('exact 70 + prefix 50')).toBeInTheDocument();
    expect(list().getByText('threshold 65')).toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('removes a line from its popover after confirming, and keeps it when cancelled', async () => {
    render();
    await userEvent.click(button('Edit link Customer owner to Account email'));
    await userEvent.click(button('Remove link'));
    expect(await screen.findByText(/Remove the link rule Customer · owner → Principal\?/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(list().getByText('Customer · owner → Principal')).toBeInTheDocument();
    await userEvent.click(button('Remove link'));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText('No link rules yet.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Edit link' })).toBeNull();
  });

  it('refuses a second rule for the same attribute and target type', async () => {
    render();
    await userEvent.click(button('owner on Customer'));
    await userEvent.click(button('Link Customer owner to Account displayName'));
    const dialog = within(screen.getByRole('dialog', { name: 'New link' }));
    expect(dialog.getByRole('combobox', { name: 'Match type 2' })).toHaveValue('name');
    await userEvent.click(dialog.getByRole('button', { name: 'Add' }));
    expect(dialog.getByRole('alert')).toHaveTextContent('Customer already links owner to Principal; edit that rule instead.');
    await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('selects a source row with the keyboard and clears it with a second press', async () => {
    render();
    const row = button('column4 on Timesheet');
    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(button('column4 on Timesheet')).toHaveAttribute('aria-pressed', 'true');
    await userEvent.keyboard(' ');
    expect(button('column4 on Timesheet')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: /^Link / })).toBeNull();
  });

  it('renames an entity type: Enter saves, then a toast and a reload', async () => {
    const { authFetch, onRelinked } = render({ handler: (url) => (url.endsWith('/rename-type')
      ? { profile: { id: 'p2' }, renamedEntities: 40, otherProfiles: [] } : undefined) });
    await userEvent.click(button('Rename Customer'));
    const field = screen.getByRole('textbox', { name: 'New name for Customer' });
    expect(field).toHaveValue('Customer');
    await userEvent.clear(field);
    await userEvent.type(field, 'Client{Enter}');
    const [url, opts] = authFetch.mock.calls.find(([u]) => u.endsWith('/rename-type'));
    expect(url).toBe('/api/org-truth/profiles/p1/rename-type');
    expect(JSON.parse(opts.body)).toEqual({ from: 'Customer', to: 'Client' });
    expect(await screen.findByText('Renamed Customer to Client')).toBeInTheDocument();
    expect(onRelinked).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('textbox', { name: 'New name for Customer' })).toBeNull();
  });

  it('cancels a rename with Escape and sends nothing for an unchanged name', async () => {
    const { authFetch } = render();
    await userEvent.click(button('Rename Timesheet'));
    await userEvent.type(screen.getByRole('textbox', { name: 'New name for Timesheet' }), '{Escape}');
    expect(screen.queryByRole('textbox')).toBeNull();
    await userEvent.click(button('Rename Timesheet'));
    await userEvent.type(screen.getByRole('textbox', { name: 'New name for Timesheet' }), '{Enter}');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('shows a refused rename (409)', async () => {
    render({ handler: () => jsonResponse({ error: 'The name "Timesheet" is already used.' }, { ok: false, status: 409 }) });
    await userEvent.click(button('Rename Customer'));
    const field = screen.getByRole('textbox', { name: 'New name for Customer' });
    await userEvent.clear(field);
    await userEvent.type(field, 'Timesheet{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('The name "Timesheet" is already used.');
  });

  it('asks before a rename discards unsaved rule edits', async () => {
    render();
    await userEvent.click(button('Remove Customer · owner → Principal'));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    await userEvent.click(button('Rename Customer'));
    await userEvent.click(await screen.findByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    await userEvent.click(button('Rename Customer'));
    await userEvent.click(await screen.findByRole('button', { name: 'Discard and rename' }));
    expect(screen.getByRole('textbox', { name: 'New name for Customer' })).toBeInTheDocument();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(list().getByText('Customer · owner → Principal')).toBeInTheDocument();
  });

  it('shows a reader the rules without any control', () => {
    const { container } = render({ auth: READER });
    expect(container.querySelector('[data-line="0"]')).not.toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(list().getByText('Customer · owner → Principal')).toBeInTheDocument();
    expect(screen.queryByText(/Click an attribute/)).toBeNull();
  });

  it('renders nothing without profiles', () => {
    const authFetch = makeAuthFetch({});
    const { container } = renderWithProviders(<LinkRulesEditor model={{ ...MODEL, profiles: [] }} onRelinked={() => {}} />,
      { auth: { authFetch, ...IMPORTER }, features: { orgTruth: true } });
    expect(container.querySelector('section')).toBeNull();
  });
});
