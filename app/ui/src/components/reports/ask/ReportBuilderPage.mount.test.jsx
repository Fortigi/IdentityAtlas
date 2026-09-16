// @vitest-environment jsdom
//
// The report builder tab (create / edit) — what this pins down:
//   • a new report opens on an empty, editable definition seeded from the
//     entity's defaultColumns, and asks the API to run nothing
//   • a saved report seeds name/description/question/definition from the row and
//     previews that definition EXACTLY once (the preview is deferred by a timer,
//     so "once" is asserted on a settled page, not mid-race)
//   • saving sends name + description + question + the definition that actually
//     ran; a new report then hands its tab over to the saved report's own id
//   • a "did you mean" answer is resolved server-side and the resolved
//     definition is what gets re-run
//   • a rejected definition is reported with the server's own reasons
//   • the page offers nothing to save when the analyst may not build reports
//
// The catalog fixture is deliberately awkward: `resource` is listed before
// `user`, and `defaultColumns` is a strict subset of `columns`. A blank report
// that took the catalog's first entity, or every column the entity offers,
// would look right against a tidier fixture.
import { describe, it, expect, vi } from 'vitest';
import {
  renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent, act, waitFor,
} from '@ui/test-utils/renderWithProviders';
import ReportBuilderPage from './ReportBuilderPage';

const SAVED_ID = '2f1c6e2a-1111-4b3a-9c7d-000000000001';
const CATALOG_URL = '/api/nl-reports/catalog';
const RUN = '/api/nl-reports/run';
const RESOLVE = '/api/nl-reports/resolve';
const CREATE = '/api/nl-reports/saved';
const UPDATE = `/api/nl-reports/saved/${SAVED_ID}`;

const CATALOG = {
  entities: {
    resource: {
      label: 'Resource',
      defaultColumns: ['displayName'],
      compareRelations: [],
      relations: [],
      fields: [{ name: 'displayName', label: 'Resource name', type: 'string' }],
      columns: [{ key: 'displayName', label: 'Resource name' }],
    },
    user: {
      label: 'User',
      defaultColumns: ['displayName', 'userPrincipalName'],
      compareRelations: [],
      relations: [],
      fields: [
        { name: 'displayName', label: 'Display name', type: 'string' },
        { name: 'accountEnabled', label: 'Enabled', type: 'boolean' },
      ],
      columns: [
        { key: 'displayName', label: 'Display name' },
        { key: 'userPrincipalName', label: 'Sign-in name' },
        { key: 'department', label: 'Department' },
      ],
    },
  },
  operators: { equals: { label: 'is', needsValue: true }, contains: { label: 'contains', needsValue: true } },
  operatorsByType: { string: ['equals', 'contains'], boolean: ['equals'] },
};

const BLANK = { entity: 'user', match: 'all', conditions: [], columns: ['displayName', 'userPrincipalName'] };

const SAVED_DEF = {
  entity: 'user',
  match: 'all',
  conditions: [{ type: 'field', field: 'displayName', op: 'contains', value: 'Fortigi' }],
  columns: ['displayName', 'department'],
};

const SAVED = {
  id: SAVED_ID,
  name: 'Guests without a manager',
  description: 'Guest accounts whose manager is gone.',
  question: 'guest accounts without a manager',
  definition: SAVED_DEF,
};

// What POST /run answers. `spec` is the server's validated definition, which is
// not byte-identical to what was sent — the builder must adopt the returned one.
const runResult = (spec, over = {}) => ({
  ok: true,
  spec,
  explanation: { title: 'Users where', lines: [{ depth: 0, text: 'display name contains "Fortigi"' }] },
  columns: [{ key: 'displayName', label: 'Display name' }, { key: 'department', label: 'Department' }],
  rows: [{ _entity: { kind: 'user', id: 'p1' }, displayName: 'Ada Lovelace', department: 'Research' }],
  total: 1,
  truncated: false,
  sql: 'SELECT "displayName" FROM "Principals"',
  params: ['%Fortigi%'],
  elapsedMs: 12,
  ...over,
});

const callsTo = (authFetch, url, method = 'POST') => authFetch.mock.calls
  .filter(([u, o = {}]) => String(u) === url && (o.method || 'GET') === method);

const bodies = (authFetch, url, method = 'POST') => callsTo(authFetch, url, method)
  .map(([, o]) => JSON.parse(o.body));

// Let deferred work land (the saved-report preview is kicked off from a
// setTimeout), so "exactly once" and "never" describe a settled page.
const settle = () => act(async () => {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  await new Promise((resolve) => { setTimeout(resolve, 0); });
});

function renderBuilder({
  builderId = 'new-1758000000000',
  saved,
  run = (spec) => runResult(spec),
  resolve,
  interpret,
  status = { available: false, model: 'qwen2.5-coder', loaded: false, reason: 'server-unreachable' },
  created = { id: SAVED_ID, name: 'Locked-out admins' },
  features = { customReports: true },
  auth = {},
  ...props
} = {}) {
  let runIndex = 0;
  const authFetch = makeAuthFetch((url, opts = {}) => {
    const s = String(url);
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (s.endsWith('/catalog')) return CATALOG;
    if (s.endsWith('/status')) return status;
    if (s.endsWith('/warm')) return { state: 'ready' };
    if (s.endsWith('/interpret')) return interpret?.(body);
    if (s === RUN) return run(body.spec, runIndex++);
    if (s === RESOLVE) return resolve?.(body);
    if (method === 'GET' && s.startsWith(`${CREATE}/`)) {
      return saved ?? jsonResponse({ error: 'Report not found' }, { ok: false, status: 404 });
    }
    if (method === 'POST' && s === CREATE) return jsonResponse(created, { status: 201 });
    if (method === 'PUT') return { ...SAVED, ...body };
    return undefined;
  });
  const result = renderWithProviders(
    <ReportBuilderPage builderId={builderId} {...props} />,
    { auth: { authFetch, ...auth }, features },
  );
  return { ...result, authFetch };
}

const entitySelect = () => screen.getByRole('combobox', { name: 'Report on' });
const columnPill = (label) => screen.getByRole('button', { name: label });

describe('ReportBuilderPage', () => {
  it('opens a new report on an empty definition built from the entity defaults, and runs nothing', async () => {
    const { authFetch } = renderBuilder();

    expect(await screen.findByRole('heading', { name: /New report/ })).toBeInTheDocument();
    // 'user', not 'resource' — which the catalog lists first.
    expect(entitySelect()).toHaveValue('user');
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('');
    expect(screen.queryAllByRole('button', { name: 'Remove condition' })).toHaveLength(0);
    // Exactly the entity's defaultColumns — 'Department' is offered but not on.
    expect(columnPill('Display name')).toHaveAttribute('aria-pressed', 'true');
    expect(columnPill('Sign-in name')).toHaveAttribute('aria-pressed', 'true');
    expect(columnPill('Department')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Preview the report to see how it reads.')).toBeInTheDocument();

    await settle();
    expect(bodies(authFetch, RUN)).toEqual([]);
    // Nothing to load: a "new-…" id is not a saved report id.
    expect(authFetch.mock.calls.map(([u]) => String(u))).toEqual([CATALOG_URL, '/api/nl-reports/status']);
  });

  it('seeds an edited report from the saved row and previews its definition exactly once', async () => {
    const { authFetch } = renderBuilder({ builderId: SAVED_ID, saved: SAVED });

    expect(await screen.findByRole('heading', { name: /Edit report/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue(SAVED.name);
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue(SAVED.description);
    // The saved definition, not a blank one: its condition and its columns.
    expect(screen.getByRole('combobox', { name: 'Operator' })).toHaveValue('contains');
    expect(screen.getByRole('textbox', { name: 'Display name value' })).toHaveValue('Fortigi');
    expect(columnPill('Department')).toHaveAttribute('aria-pressed', 'true');
    expect(columnPill('Sign-in name')).toHaveAttribute('aria-pressed', 'false');

    await waitFor(() => expect(bodies(authFetch, RUN)).toHaveLength(1));
    await settle(); // a second preview for the same definition would have landed by now
    expect(bodies(authFetch, RUN)).toEqual([{ spec: SAVED_DEF }]);

    expect(screen.getByText('Users where')).toBeInTheDocument();
    expect(screen.getByText(/^Preview: 1 row$/)).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Ada Lovelace' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Research' })).toBeInTheDocument();
    expect(screen.getByText('SQL (12 ms)')).toBeInTheDocument();
  });

  it('saves an edited report with the question it was built from, and keeps the tab open', async () => {
    const onCacheData = vi.fn();
    const onClose = vi.fn();
    const { authFetch } = renderBuilder({ builderId: SAVED_ID, saved: SAVED, onCacheData, onClose });

    await waitFor(() => expect(bodies(authFetch, RUN)).toHaveLength(1));
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), ' v2');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(bodies(authFetch, UPDATE, 'PUT')).toEqual([{
      name: 'Guests without a manager v2',
      description: SAVED.description,
      question: SAVED.question, // never typed here — it came off the saved row
      definition: SAVED_DEF,
    }]));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved');
    expect(onCacheData).toHaveBeenCalledWith(SAVED_ID, 'report-builder', { displayName: 'Guests without a manager v2' });
    // An edit stays where it is; only a brand-new report swaps tabs.
    expect(onClose).not.toHaveBeenCalled();
    expect(bodies(authFetch, CREATE)).toEqual([]);
  });

  it('creates a new report from what actually ran, then hands its tab to the saved id', async () => {
    const onOpenDetail = vi.fn();
    const onClose = vi.fn();
    const normalised = { ...BLANK, limit: 500 };
    const { authFetch } = renderBuilder({
      run: () => runResult(normalised),
      onOpenDetail,
      onClose,
    });

    await screen.findByRole('heading', { name: /New report/ });
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Locked-out admins');
    await userEvent.type(screen.getByRole('textbox', { name: 'Description' }), 'Admins that cannot sign in');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText(/^Preview: 1 row$/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(bodies(authFetch, CREATE)).toEqual([{
      name: 'Locked-out admins',
      description: 'Admins that cannot sign in',
      question: '',
      // The definition the server validated and ran, not the one the page sent.
      definition: normalised,
    }]));
    // The saved report's own id, so the tab can be reopened from its URL.
    expect(onOpenDetail).toHaveBeenCalledWith('report-builder', SAVED_ID, 'Locked-out admins');
    expect(onClose).toHaveBeenCalled();
  });

  it('names and remembers the question the analyst described the report with', async () => {
    const question = 'all disabled accounts';
    const modelSpec = {
      entity: 'user',
      match: 'all',
      conditions: [{ type: 'field', field: 'accountEnabled', op: 'equals', value: false }],
      columns: ['displayName'],
    };
    const { authFetch } = renderBuilder({
      status: { available: true, model: 'qwen2.5-coder', loaded: true, promptCache: 'ready' },
      interpret: () => ({ kind: 'report', assumptions: [], spec: modelSpec, raw: '{}' }),
      run: (spec) => runResult(spec),
    });

    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Describe the report you want' }),
      question,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

    // The question becomes the report's working name…
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue(question));
    // …the model's definition replaces the blank one…
    expect(await screen.findByRole('combobox', { name: 'Enabled value' })).toHaveValue('false');
    // …and it is previewed straight away.
    expect(bodies(authFetch, RUN)).toEqual([{ spec: modelSpec }]);

    // …and the question is kept, so the saved report records what was asked.
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies(authFetch, CREATE)).toEqual([
      { name: question, description: '', question, definition: modelSpec },
    ]));
  });

  it('resolves a "did you mean" answer and re-runs the resolved definition', async () => {
    const unresolved = {
      entity: 'user',
      match: 'all',
      conditions: [{ type: 'field', field: 'displayName', op: 'equals', value: 'Algemene maten' }],
      columns: ['displayName'],
    };
    const resolved = {
      ...unresolved,
      conditions: [{ type: 'field', field: 'displayName', op: 'equals', value: 'Fortigi - Algemeen - Maten' }],
    };
    const confirm = {
      kind: 'reference',
      path: [0],
      name: 'Algemene maten',
      label: 'business role',
      message: 'No business role is named exactly "Algemene maten". Did you mean:',
      choices: [{ id: 'br1', name: 'Fortigi - Algemeen - Maten', type: 'BusinessRole', score: 0.61 }],
    };
    const { authFetch } = renderBuilder({
      run: (spec, i) => (i === 0
        ? jsonResponse({ error: 'Invalid report definition', errors: [confirm.message], confirm, spec: unresolved }, { ok: false, status: 400 })
        : runResult(spec)),
      resolve: () => ({ spec: resolved, explanation: { title: 'Users where', lines: [] } }),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Preview' }));
    expect(await screen.findByText(confirm.message)).toBeInTheDocument();
    // A confirmation is a question, not a failure.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Fortigi - Algemeen - Maten/ }));

    // The choice is applied to the definition the run came back with, server-side.
    await waitFor(() => expect(bodies(authFetch, RESOLVE)).toEqual([{
      spec: unresolved,
      choice: { path: [0], name: 'Fortigi - Algemeen - Maten', id: 'br1' },
    }]));
    // Then the resolved definition — not the one that needed confirming — is run.
    await waitFor(() => expect(bodies(authFetch, RUN)).toEqual([{ spec: BLANK }, { spec: resolved }]));
    expect(await screen.findByText(/^Preview: 1 row$/)).toBeInTheDocument();
    expect(screen.queryByText(confirm.message)).not.toBeInTheDocument();
  });

  it('reports a rejected definition with the reasons the server gave', async () => {
    renderBuilder({
      run: () => jsonResponse(
        { error: 'Invalid report definition', errors: ['Unknown field "manger"'] },
        { ok: false, status: 400 },
      ),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Preview' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid report definition: Unknown field "manger"');
    expect(screen.queryByText(/^Preview: /)).not.toBeInTheDocument();
  });

  it.each([
    ['the role does not include Build custom reports', { customReports: true }, { hasWildcard: false, permissions: new Set(['data.read']) }],
    ['custom reports are switched off for the install', {}, {}],
  ])('offers nothing to save when %s', async (_why, features, auth) => {
    renderBuilder({ features, auth });

    expect(await screen.findByRole('heading', { name: 'You cannot build reports here' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
  });
});
