// @vitest-environment jsdom
//
// Organisation → Model → the model canvas: ONE canvas for two lists. The
// merged cards and the cross-list line; dragging a card (position, line end
// points, the shared layout PUT), a saved layout, Reset layout, arrow-key
// moves, pan and zoom, highlighting a list; drawing a relation by dragging
// and by clicking, each edit landing in (and saving to) the profile that owns
// the entity type; edit, remove, duplicate refusal, the 400 list, renaming
// through the owning profile, and the read-only view.
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent, waitFor, within, fireEvent } from '@ui/test-utils/renderWithProviders';
import LinkRulesEditor from './LinkRulesEditor';

const IMPORTER = { hasWildcard: false, permissions: new Set(['data.read', 'data.write.contexts']) };
const READER = { hasWildcard: false, permissions: new Set(['data.read']) };
const LAYOUT = '/api/org-truth/canvas-layout';

const sig = (attribute, targetField, type, weight) => ({ attribute, targetField, type, weight });
const OWNER_RULE = { entityType: 'Customer', targetType: 'Principal', via: 'owner', threshold: 50, signals: [sig('owner', 'email', 'exact', 90)] };
const TS_STAFF = { entityType: 'Timesheet', targetType: 'OrgEntity', targetEntityType: 'Staff', via: 'employee', threshold: 60,
  signals: [sig('employee', 'displayName', 'fuzzy', 100)] };
const STAFF_MAIL = { entityType: 'Staff', targetType: 'Identity', via: 'email', threshold: 50, signals: [sig('email', 'email', 'exact', 90)] };

const HOURS = {
  id: 'p1', name: 'Contoso hours', version: 3, lastSourceId: 's1', lastRunStatus: 'completed',
  recipe: { version: 1, entities: [
    { type: 'Timesheet', nameColumn: 'Code', attributes: [{ column: 'c4', name: 'column4' }, { column: 'Who', name: 'employee' }] },
    { type: 'Customer', nameColumn: 'Name', attributes: [{ column: 'Owner', name: 'owner' }] },
  ] },
  linkRules: [OWNER_RULE, TS_STAFF],
};
const STAFF = {
  id: 'p2', name: 'Northwind staff', version: 1, lastSourceId: 's2', lastRunStatus: 'completed',
  recipe: { version: 1, entities: [{ type: 'Staff', nameColumn: 'Name', attributes: [{ column: 'Mail', name: 'email' }] }] },
  linkRules: [STAFF_MAIL],
};
const MODEL = {
  entityTypes: [{ type: 'Timesheet', count: 900 }, { type: 'Customer', count: 40 }, { type: 'Staff', count: 30 }],
  systemTypes: [{ targetType: 'Principal', count: 1127 }],
  predicates: [{ predicate: 'for', fromType: 'Timesheet', toType: 'Customer', count: 870 }],
  links: [{ entityType: 'Customer', targetType: 'Principal', via: 'owner', accepted: 30, proposed: 2 }],
  entityLinks: [{ fromType: 'Timesheet', toType: 'Staff', via: 'employee', accepted: 850, proposed: 12 }],
  profiles: [HOURS, STAFF],
};

// The automatic layout of MODEL (canvasLayout.autoLayout): Contoso hours left
// of the system column, Northwind staff right of it.
//   Timesheet 24,24  Customer 24,178  Staff 664,24  Account 344,24  Person 344,178
const CROSS_BEFORE = 'M 224 133 C 444 133 444 81 664 81';

function sequence(...answers) {
  let i = 0;
  return () => answers[Math.min(i++, answers.length - 1)];
}

function layoutHandler(saved = { positions: {} }) {
  return (url, opts = {}) => {
    if (url !== LAYOUT) return undefined;
    return opts.method === 'PUT' ? JSON.parse(opts.body) : saved;
  };
}

async function render({ auth = IMPORTER, handler, layout = layoutHandler(), model = MODEL } = {}) {
  const authFetch = makeAuthFetch((url, opts) => layout(url, opts) ?? handler?.(url, opts));
  const onRelinked = vi.fn();
  const r = renderWithProviders(<LinkRulesEditor model={model} onRelinked={onRelinked} />,
    { auth: { authFetch, ...auth }, features: { orgTruth: true } });
  await screen.findByRole('group', { name: 'Model canvas' });
  return { authFetch, onRelinked, ...r };
}

const button = (name) => screen.getByRole('button', { name });
const svg = () => screen.getByRole('group', { name: 'Model canvas' });
const list = (name) => within(screen.getByRole('list', { name: `Link rules of ${name}` }));
const profile = (container, name) => within(container.querySelector(`[data-profile="${name}"]`));
const cardAt = (container, id) => {
  const rect = container.querySelector(`[data-box="${id}"] > rect`);
  return { x: Number(rect.getAttribute('x')), y: Number(rect.getAttribute('y')) };
};
const linePathOf = (container, key) => container.querySelector(`[data-line="${key}"] path`).getAttribute('d');
const layoutPuts = (authFetch) => authFetch.mock.calls.filter(([u, o]) => u === LAYOUT && o?.method === 'PUT').map(([, o]) => JSON.parse(o.body));

function drag(from, to, target) {
  fireEvent.pointerDown(target, { clientX: from.x, clientY: from.y, pointerId: 1, button: 0 });
  fireEvent.pointerMove(svg(), { clientX: (from.x + to.x) / 2, clientY: (from.y + to.y) / 2, pointerId: 1 });
  fireEvent.pointerMove(svg(), { clientX: to.x, clientY: to.y, pointerId: 1 });
  fireEvent.pointerUp(svg(), { clientX: to.x, clientY: to.y, pointerId: 1 });
}
const header = (container, id) => container.querySelector(`[data-box="${id}"] [data-drag="box"] rect`);

describe('LinkRulesEditor — one canvas for every list', () => {
  it('draws the types of both lists as cards with their list chip, the system cards, and every line across lists', async () => {
    const { container } = await render();
    expect(screen.getByRole('heading', { name: 'Model canvas' })).toBeInTheDocument();
    const cards = [...container.querySelectorAll('[data-box]')].map(b => [b.getAttribute('data-box'), b.querySelector('[data-chip]').textContent]);
    expect(cards).toEqual([
      ['e:Timesheet', 'Contoso hours'], ['e:Customer', 'Contoso hours'], ['e:Staff', 'Northwind staff'],
      ['s:Principal', 'System'], ['s:Identity', 'System'], ['s:Resource', 'System'], ['s:Context', 'System'],
    ]);
    expect([...container.querySelectorAll('[data-line]')].map(l => l.getAttribute('data-line')))
      .toEqual(['Contoso hours#0', 'Contoso hours#1', 'Northwind staff#0']);
    expect(linePathOf(container, 'Contoso hours#1')).toBe(CROSS_BEFORE);
    expect(button('Edit link Timesheet employee to Staff name')).toHaveTextContent('fuzzy 100 · 850 accepted · 12 proposed');
    expect(container.querySelector('[data-predicate="p:Timesheet:for:Customer"]')).toHaveTextContent('for 870');
    expect(list('Contoso hours').getByText('Timesheet · employee → Staff')).toBeInTheDocument();
    expect(list('Northwind staff').getByText('Staff · email → Identity')).toBeInTheDocument();
    expect(screen.getAllByText('Save and link again').map(b => b.closest('button').disabled)).toEqual([true, true]);
  });

  it('drags a card: it follows the pointer, the cross-list line follows it, and the layout is saved whole', async () => {
    const { container, authFetch } = await render();
    expect(cardAt(container, 'e:Staff')).toEqual({ x: 664, y: 24 });
    drag({ x: 700, y: 30 }, { x: 600, y: 230 }, header(container, 'e:Staff'));
    expect(cardAt(container, 'e:Staff')).toEqual({ x: 564, y: 224 });
    expect(linePathOf(container, 'Contoso hours#1')).toBe('M 224 133 C 394 133 394 281 564 281');
    await waitFor(() => expect(layoutPuts(authFetch)).toHaveLength(1));
    const [{ positions }] = layoutPuts(authFetch);
    expect(positions['e:Staff']).toEqual({ x: 564, y: 224 });
    expect(positions['e:Timesheet']).toEqual({ x: 24, y: 24 });
    expect(Object.keys(positions)).toHaveLength(7);
  });

  it('treats a press that barely moves as no drag', async () => {
    const { container, authFetch } = await render();
    drag({ x: 700, y: 30 }, { x: 702, y: 31 }, header(container, 'e:Staff'));
    expect(cardAt(container, 'e:Staff')).toEqual({ x: 664, y: 24 });
    expect(layoutPuts(authFetch)).toEqual([]);
  });

  it('puts the cards where the shared layout says, and a card it does not know below them', async () => {
    const { container } = await render({ layout: layoutHandler({ positions: { 'e:Staff': { x: 1000, y: 500 } } }) });
    expect(cardAt(container, 'e:Staff')).toEqual({ x: 1000, y: 500 });
    // Staff ends at 500 + 44 + 2·26 = 596; the others start 64 under it.
    expect(cardAt(container, 'e:Timesheet')).toEqual({ x: 24, y: 660 });
  });

  it('falls back to the automatic layout when the layout cannot be read', async () => {
    const { container } = await render({ layout: (url) => (url === LAYOUT ? jsonResponse({}, { ok: false, status: 501 }) : undefined) });
    expect(cardAt(container, 'e:Staff')).toEqual({ x: 664, y: 24 });
  });

  it('resets the layout: the cards go back to the automatic places and an empty layout is saved', async () => {
    const { container, authFetch } = await render({ layout: layoutHandler({ positions: { 'e:Staff': { x: 1000, y: 500 } } }) });
    await userEvent.click(button('Reset layout'));
    expect(cardAt(container, 'e:Staff')).toEqual({ x: 664, y: 24 });
    expect(layoutPuts(authFetch)).toEqual([{ positions: {} }]);
  });

  it('moves a focused card with the arrow keys and saves', async () => {
    const { container, authFetch } = await render();
    screen.getByLabelText('Move Customer').focus();
    await userEvent.keyboard('{ArrowRight}{ArrowDown}{Enter}');
    expect(cardAt(container, 'e:Customer')).toEqual({ x: 44, y: 198 });
    await waitFor(() => expect(layoutPuts(authFetch)).toHaveLength(2));
    expect(layoutPuts(authFetch)[1].positions['e:Customer']).toEqual({ x: 44, y: 198 });
  });

  it('says so when the layout could not be saved', async () => {
    const { container } = await render({ layout: (url, opts = {}) => {
      if (url !== LAYOUT) return undefined;
      return opts.method === 'PUT' ? jsonResponse({}, { ok: false, status: 500 }) : { positions: {} };
    } });
    drag({ x: 700, y: 30 }, { x: 600, y: 230 }, header(container, 'e:Staff'));
    expect(await screen.findByText('The layout was not saved: HTTP 500')).toBeInTheDocument();
    expect(cardAt(container, 'e:Staff')).toEqual({ x: 564, y: 224 });
  });

  it('pans with a background drag and zooms with the buttons and the wheel', async () => {
    const { container } = await render();
    const view = () => container.querySelector('[data-view]').getAttribute('data-view');
    expect(view()).toBe('0,0,1');
    drag({ x: 10, y: 10 }, { x: 60, y: 40 }, svg());
    expect(view()).toBe('50,30,1');
    // The wheel zooms around the pointer: the canvas point under it (0,0) stays put.
    fireEvent.wheel(svg(), { deltaY: -100, clientX: 50, clientY: 30 });
    const wheel = view().split(',').map(Number);
    expect(wheel.slice(0, 2)).toEqual([50, 30]);
    expect(wheel[2]).toBeCloseTo(Math.exp(0.15), 6);
    // The buttons zoom around the SVG's centre (0,0 in a test without layout).
    await userEvent.click(button('Zoom in'));
    const zoomed = view().split(',').map(Number);
    expect(zoomed[0]).toBeCloseTo(60, 6);
    expect(zoomed[2]).toBeCloseTo(Math.exp(0.15) * 1.2, 6);
    await userEvent.click(button('Zoom out'));
    expect(Number(view().split(',')[2])).toBeCloseTo(Math.exp(0.15), 6);
  });

  it('fits the whole canvas into the visible area', async () => {
    const { container } = await render();
    vi.spyOn(svg(), 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1000, height: 600 });
    await userEvent.click(button('Fit'));
    // Cards span 24..864 × 24..556; with the margin 888 × 580, centred at 100 %.
    expect(container.querySelector('[data-view]').getAttribute('data-view')).toBe('56,10,1');
  });

  it('highlights one list and fades the cards and lines of the others', async () => {
    const { container } = await render();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Highlight list' }), 'Northwind staff');
    const opacity = (sel) => container.querySelector(sel).getAttribute('opacity');
    expect(opacity('[data-box="e:Staff"]')).toBe('1');
    expect(opacity('[data-box="e:Timesheet"]')).toBe('0.3');
    expect(opacity('[data-box="s:Principal"]')).toBe('1');
    expect(opacity('[data-line="Northwind staff#0"]')).toBe('1');
    expect(opacity('[data-line="Contoso hours#1"]')).toBe('0.3');
    expect(opacity('[data-predicate="p:Timesheet:for:Customer"]')).toBe('0.3');
  });
});

describe('LinkRulesEditor — edits route to the owning profile', () => {
  it('draws a relation by dragging Staff email onto Account employeeId; it is Northwind staff that saves it', async () => {
    const run = sequence({ id: 'r2', status: 'completed', stats: { links: { linked: 28, proposed: 1 } } });
    const { container, authFetch, onRelinked } = await render({ handler: (url) => {
      if (url === '/api/org-truth/profiles/p2/relink') return jsonResponse({ profile: { id: 'p3' }, run: { id: 'r2', status: 'queued' } }, { status: 202 });
      if (url === '/api/org-truth/runs/r2') return run();
      return undefined;
    } });
    // Staff email row: 664..864 × 94..120; Account employeeId row: 344..544 × 120..146.
    const source = container.querySelector('[data-row="e:Staff|email"] rect');
    fireEvent.pointerDown(source, { clientX: 700, clientY: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(svg(), { clientX: 500, clientY: 120, pointerId: 1 });
    expect(container.querySelector('[data-ghost]')).toHaveAttribute('x1', '864');
    fireEvent.pointerUp(svg(), { clientX: 400, clientY: 130, pointerId: 1 });
    expect(container.querySelector('[data-ghost]')).toBeNull();

    const dialog = within(screen.getByRole('dialog', { name: 'New link' }));
    expect(dialog.getByText('New link: Staff · email → Principal')).toBeInTheDocument();
    expect(dialog.getByText('on employeeId')).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: 'Add' }));

    expect(profile(container, 'Northwind staff').getByText('Unsaved changes')).toBeInTheDocument();
    expect(profile(container, 'Contoso hours').queryByText('Unsaved changes')).toBeNull();
    expect(button('Save and link again: Contoso hours')).toBeDisabled();
    await userEvent.click(button('Save and link again: Northwind staff'));

    const posts = authFetch.mock.calls.filter(([u]) => u.endsWith('/relink'));
    expect(posts.map(([u]) => u)).toEqual(['/api/org-truth/profiles/p2/relink']);
    expect(JSON.parse(posts[0][1].body)).toEqual({ linkRules: [
      STAFF_MAIL,
      { entityType: 'Staff', targetType: 'Principal', via: 'email', threshold: 50, signals: [sig('email', 'employeeId', 'exact', 90)] },
    ] });
    expect(await screen.findByText('Linked again: 28 linked, 1 proposed for review.', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(onRelinked).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  }, 10000);

  it('a drag released on nothing, or on the source card itself, opens nothing', async () => {
    const { container } = await render();
    const source = container.querySelector('[data-row="e:Staff|email"] rect');
    drag({ x: 700, y: 100 }, { x: 1500, y: 900 }, source);
    drag({ x: 700, y: 100 }, { x: 700, y: 75 }, source); // Staff's own name row
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('adds Timesheet · column4 → Staff by clicking, saves Contoso hours with its full list, shows progress', async () => {
    const run = sequence({ id: 'r1', status: 'running', step: 'link', pct: 40 }, { id: 'r1', status: 'completed', stats: { links: { linked: 850, proposed: 12 } } });
    const { authFetch, onRelinked } = await render({ handler: (url) => {
      if (url === '/api/org-truth/profiles/p1/relink') return jsonResponse({ profile: { id: 'p4' }, run: { id: 'r1', status: 'queued' } }, { status: 202 });
      if (url === '/api/org-truth/runs/r1') return run();
      return undefined;
    } });
    await userEvent.click(button('column4 on Timesheet'));
    expect(button('column4 on Timesheet')).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(button('Link Timesheet column4 to Staff name'));
    const dialog = within(screen.getByRole('dialog', { name: 'New link' }));
    expect(dialog.getByRole('combobox', { name: 'Match type 1' })).toHaveValue('fuzzy');
    expect(dialog.getByRole('spinbutton', { name: 'Threshold' })).toHaveValue(60);
    await userEvent.click(dialog.getByRole('button', { name: 'Add' }));
    expect(list('Contoso hours').getByText('Timesheet · column4 → Staff')).toBeInTheDocument();

    await userEvent.click(button('Save and link again: Contoso hours'));
    const post = authFetch.mock.calls.find(([u]) => u.endsWith('/relink'));
    expect(post[0]).toBe('/api/org-truth/profiles/p1/relink');
    expect(JSON.parse(post[1].body).linkRules.map(r => `${r.entityType}.${r.via}>${r.targetEntityType ?? r.targetType}`))
      .toEqual(['Customer.owner>Principal', 'Timesheet.employee>Staff', 'Timesheet.column4>Staff']);
    expect(await screen.findByText('Linking again… queued')).toBeInTheDocument();
    // While a list links again, the canvas takes no new edits.
    expect(screen.queryByRole('button', { name: 'column4 on Timesheet' })).toBeNull();
    expect(await screen.findByText('Linking again… link (40%)', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(await screen.findByText('Linked again: 850 linked, 12 proposed for review.', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(onRelinked).toHaveBeenCalledTimes(1);
    expect(button('column4 on Timesheet')).toBeInTheDocument();
  }, 10000);

  it('edits a line of the second list in its popover', async () => {
    const { container } = await render();
    await userEvent.click(button('Edit link Staff email to Person email'));
    const dialog = within(screen.getByRole('dialog', { name: 'Edit link' }));
    fireEvent.change(dialog.getByRole('spinbutton', { name: 'Weight 1' }), { target: { value: '70' } });
    fireEvent.change(dialog.getByRole('spinbutton', { name: 'Threshold' }), { target: { value: '65' } });
    await userEvent.click(dialog.getByRole('button', { name: 'Save' }));
    expect(list('Northwind staff').getByText('exact 70')).toBeInTheDocument();
    expect(list('Northwind staff').getByText('threshold 65')).toBeInTheDocument();
    expect(profile(container, 'Northwind staff').getByText('Unsaved changes')).toBeInTheDocument();
    expect(profile(container, 'Contoso hours').queryByText('Unsaved changes')).toBeNull();
  });

  it('removes the cross-list line from its popover after confirming, and keeps it when cancelled', async () => {
    const { container } = await render();
    await userEvent.click(button('Edit link Timesheet employee to Staff name'));
    await userEvent.click(button('Remove link'));
    await userEvent.click(await screen.findByRole('button', { name: 'Keep it' }));
    expect(list('Contoso hours').getByText('Timesheet · employee → Staff')).toBeInTheDocument();
    await userEvent.click(button('Remove link'));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(list('Contoso hours').queryByText('Timesheet · employee → Staff')).toBeNull();
    expect(container.querySelector('[data-line="Contoso hours#1"]')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Edit link' })).toBeNull();
  });

  it('opens a rule of the list under the canvas in the popover', async () => {
    await render();
    await userEvent.click(button('Edit Staff · email → Identity'));
    expect(within(screen.getByRole('dialog', { name: 'Edit link' })).getByText('Edit link: Staff · email → Identity')).toBeInTheDocument();
  });

  it('removes a rule from the list under the canvas', async () => {
    await render();
    await userEvent.click(button('Remove Staff · email → Identity'));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(screen.getByText('No link rules yet.')).toBeInTheDocument();
  });

  it('refuses a second rule for the same attribute and target type', async () => {
    await render();
    await userEvent.click(button('owner on Customer'));
    await userEvent.click(button('Link Customer owner to Account displayName'));
    const dialog = within(screen.getByRole('dialog', { name: 'New link' }));
    await userEvent.click(dialog.getByRole('button', { name: 'Add' }));
    expect(dialog.getByRole('alert')).toHaveTextContent('Customer already links owner to Principal; edit that rule instead.');
    await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('shows the 400 reasons of a refused save and keeps the edits', async () => {
    await render({ handler: (url) => (url.endsWith('/relink')
      ? jsonResponse({ error: 'The link rules are not valid.', errors: ['Link rule 2 uses attribute "x".'] }, { ok: false, status: 400 })
      : undefined) });
    await userEvent.click(button('Remove Staff · email → Identity'));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await userEvent.click(button('Save and link again: Northwind staff'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The link rules are not valid.');
    expect(within(alert).getAllByRole('listitem').map(li => li.textContent)).toEqual(['Link rule 2 uses attribute "x".']);
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(button('column4 on Timesheet')).toBeInTheDocument();
  });

  it('selects a source row with the keyboard and clears it with a second press', async () => {
    await render();
    button('column4 on Timesheet').focus();
    await userEvent.keyboard('{Enter}');
    expect(button('column4 on Timesheet')).toHaveAttribute('aria-pressed', 'true');
    await userEvent.keyboard(' ');
    expect(button('column4 on Timesheet')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: /^Link / })).toBeNull();
  });

  it('renames a type of the second list through that list: POST /profiles/p2/rename-type', async () => {
    const { authFetch, onRelinked } = await render({ handler: (url) => (url.endsWith('/rename-type')
      ? { profile: { id: 'p3' }, renamedEntities: 30, otherProfiles: ['Contoso hours'] } : undefined) });
    await userEvent.click(button('Rename Staff'));
    const field = screen.getByRole('textbox', { name: 'New name for Staff' });
    await userEvent.clear(field);
    await userEvent.type(field, 'Employee{Enter}');
    const [url, opts] = authFetch.mock.calls.find(([u]) => u.endsWith('/rename-type'));
    expect(url).toBe('/api/org-truth/profiles/p2/rename-type');
    expect(JSON.parse(opts.body)).toEqual({ from: 'Staff', to: 'Employee' });
    expect(await screen.findByText('Renamed Staff to Employee')).toBeInTheDocument();
    expect(onRelinked).toHaveBeenCalledTimes(1);
  });

  it('cancels a rename with Escape and sends nothing for an unchanged name', async () => {
    const { authFetch } = await render();
    await userEvent.click(button('Rename Timesheet'));
    await userEvent.type(screen.getByRole('textbox', { name: 'New name for Timesheet' }), '{Escape}');
    expect(screen.queryByRole('textbox')).toBeNull();
    await userEvent.click(button('Rename Timesheet'));
    await userEvent.type(screen.getByRole('textbox', { name: 'New name for Timesheet' }), '{Enter}');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(authFetch.mock.calls.filter(([u]) => u.includes('/profiles/'))).toEqual([]);
  });

  it('shows a refused rename (409)', async () => {
    await render({ handler: () => jsonResponse({ error: 'An entity type "Timesheet" already exists; pick another name.' }, { ok: false, status: 409 }) });
    await userEvent.click(button('Rename Customer'));
    const field = screen.getByRole('textbox', { name: 'New name for Customer' });
    await userEvent.clear(field);
    await userEvent.type(field, 'Timesheet{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('An entity type "Timesheet" already exists; pick another name.');
  });

  it('asks before a rename discards the unsaved edits of the owning list only', async () => {
    const { container } = await render();
    await userEvent.click(button('Remove Customer · owner → Principal'));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    // Staff belongs to the other list: no question.
    await userEvent.click(button('Rename Staff'));
    expect(screen.getByRole('textbox', { name: 'New name for Staff' })).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'New name for Staff' }), '{Escape}');

    await userEvent.click(button('Rename Customer'));
    await userEvent.click(await screen.findByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    await userEvent.click(button('Rename Customer'));
    await userEvent.click(await screen.findByRole('button', { name: 'Discard and rename' }));
    expect(screen.getByRole('textbox', { name: 'New name for Customer' })).toBeInTheDocument();
    expect(profile(container, 'Contoso hours').queryByText('Unsaved changes')).toBeNull();
    expect(list('Contoso hours').getByText('Customer · owner → Principal')).toBeInTheDocument();
  });
});

describe('LinkRulesEditor — readers and edge cases', () => {
  it('shows a reader every line and list without rule controls; dragging moves a card for this visit only', async () => {
    const { container, authFetch } = await render({ auth: READER });
    expect(container.querySelectorAll('[data-line]')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /^(Rename|Edit|Remove|Save and link again)/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'column4 on Timesheet' })).toBeNull();
    expect(container.querySelector('[data-drag="row"]')).toBeNull();
    expect(screen.queryByText(/Drag from an attribute/)).toBeNull();
    drag({ x: 700, y: 30 }, { x: 600, y: 230 }, header(container, 'e:Staff'));
    expect(cardAt(container, 'e:Staff')).toEqual({ x: 564, y: 224 });
    await userEvent.click(button('Reset layout'));
    expect(cardAt(container, 'e:Staff')).toEqual({ x: 664, y: 24 });
    expect(layoutPuts(authFetch)).toEqual([]);
  });

  it('draws a type no list describes read-only', async () => {
    const { container } = await render({ model: { ...MODEL, entityTypes: [...MODEL.entityTypes, { type: 'Asset', count: 2, attributeKeys: ['serial'] }] } });
    expect(container.querySelector('[data-box="e:Asset"] [data-chip]')).toHaveTextContent('No list');
    expect(screen.queryByRole('button', { name: 'Rename Asset' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'serial on Asset' })).toBeNull();
  });

  it('renders nothing for a model without lists or types', () => {
    const { container } = renderWithProviders(<LinkRulesEditor model={{ entityTypes: [], profiles: [] }} onRelinked={() => {}} />,
      { auth: { authFetch: makeAuthFetch({}), ...IMPORTER }, features: { orgTruth: true } });
    expect(container.querySelector('section')).toBeNull();
  });

  it('draws templates that are not collections as a block on the system card and dashed edges, never as cards', async () => {
    const EXPERTISE = { id: 'p3', name: 'Expertise list', version: 1,
      recipe: { version: 1, template: 'enrichment', enrich: { targetType: 'Identity' }, entities: [{ type: 'Maten', nameColumn: 'Name', attributes: [{ column: 'Exp', name: 'expertises' }] }] },
      linkRules: [] };
    const model = {
      ...MODEL,
      entityTypes: [...MODEL.entityTypes, { type: 'Maten', template: 'enrichment', count: 30 }, { type: 'Incompatibility', template: 'relation', count: 4 }],
      profiles: [...MODEL.profiles, EXPERTISE],
      enrichments: [{ type: 'Maten', targetType: 'Identity', profileName: 'Expertise list', attributes: [{ name: 'expertises' }, { name: 'level' }] }],
      activities: [{ type: 'Uren', profileName: 'Hours', actorTypes: ['Principal'], subjectType: 'OrgEntity', subjectEntityType: 'Customer', rows: 1152, unit: 'h' }],
      pairs: [{ type: 'Incompatibility', predicate: 'incompatibleWith', leftType: 'Resource', rightType: 'Resource', count: 4 }],
    };
    const { container } = await render({ model });
    expect(container.querySelector('[data-box="e:Maten"]')).toBeNull();
    expect(container.querySelector('[data-box="e:Incompatibility"]')).toBeNull();
    const block = container.querySelector('[data-box="s:Identity"] [data-block="x:Expertise list"]');
    expect(block).not.toBeNull();
    expect(block.textContent).toContain('+ expertises · level');
    expect(block.textContent).toContain('(Maten)');
    expect(container.querySelector('[data-box="s:Principal"] [data-block]')).toBeNull();
    expect(container.querySelector('[data-edge="a:Hours"]').textContent).toContain('Uren · 1,152 rows · h');
    expect(container.querySelector('[data-edge="r:Incompatibility:incompatibleWith"]').textContent).toContain('incompatibleWith 4');
  });
});
