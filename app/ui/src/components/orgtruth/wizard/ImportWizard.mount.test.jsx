// @vitest-environment jsdom
//
// The import wizard end to end against authFetch stubs: a new import (upload →
// propose → detect → dry run → start → completed), a repeat with and without
// adjusting, a repeat opened by profileId, and the "not available yet" path a
// live 501 takes.
import { describe, it, expect, vi } from 'vitest';
import {
  renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent, waitFor, within, fireEvent,
} from '@ui/test-utils/renderWithProviders';
import ImportWizard from './ImportWizard';

const COLUMNS = [
  { name: 'ProjectCode', shape: 'text', nonEmpty: 3, distinct: 3 },
  { name: 'ProjectName', shape: 'text', nonEmpty: 3, distinct: 3 },
  { name: 'OwnerName', shape: 'text', nonEmpty: 3, distinct: 2 },
  { name: 'OwnerEmail', shape: 'email', nonEmpty: 3, distinct: 2 },
];
const SOURCE = { id: 'src-1', displayName: 'Contoso projects', fileName: 'projects.csv', observedAt: '2026-10-01', rowCount: 3, columns: COLUMNS };
const RECIPE = {
  version: 1,
  entities: [
    { type: 'Project', nameColumn: 'ProjectName', keyColumn: 'ProjectCode', attributes: [] },
    { type: 'Owner', nameColumn: 'OwnerName', keyColumn: 'OwnerEmail', attributes: [{ column: 'OwnerEmail', name: 'email' }] },
  ],
  relations: [{ predicate: 'owner', from: 'Project', to: 'Owner' }],
};
const CANDIDATES = [
  { attribute: 'email', targetType: 'Principal', targetField: 'email', type: 'exact', unique: 2, multiple: 0, none: 1, uniquePct: 94, suggestedWeight: 90 },
];
const REPORT = {
  rows: 3, columns: COLUMNS,
  entities: { Project: { total: 3, duplicateKeys: 0, emptyKeys: 0 }, Owner: { total: 2, duplicateKeys: 0, emptyKeys: 0 } },
  relations: { owner: 3 },
  links: { Owner: { total: 2, unique: 2, ambiguous: 0, none: 0, samples: { ambiguous: [], none: [] } } },
  wouldClose: {}, issues: [],
};
const PROFILE = {
  id: 7, name: 'Contoso projects', version: 3, recipe: RECIPE,
  linkRules: [{ entityType: 'Owner', targetType: 'Principal', threshold: 50, signals: [{ attribute: 'email', targetField: 'email', type: 'exact', weight: 90 }] }],
};

// A tiny router: `routes['POST /sources']` → body | Response | (opts) => body.
function api(routes) {
  return makeAuthFetch((url, opts) => {
    const key = `${opts.method ?? 'GET'} ${String(url).replace('/api/org-truth', '')}`;
    const r = routes[key];
    return typeof r === 'function' ? r(opts) : r;
  });
}

const bodyOf = (authFetch, key) => {
  const call = authFetch.mock.calls.find(([url, opts]) => `${opts?.method ?? 'GET'} ${url.replace('/api/org-truth', '')}` === key);
  return call && JSON.parse(call[1].body);
};

const next = () => userEvent.click(screen.getByRole('button', { name: 'Next →' }));

async function upload(name = 'projects.csv') {
  const file = new File(['ProjectCode;ProjectName\nP1;Apollo'], name, { type: 'text/csv', lastModified: Date.UTC(2026, 8, 30) });
  await userEvent.upload(screen.getByLabelText('Choose file'), file);
  return file;
}

function render(authFetch, props = {}) {
  const onClose = vi.fn();
  renderWithProviders(<ImportWizard onClose={onClose} {...props} />, { auth: { authFetch } });
  return onClose;
}

describe('ImportWizard — new import', () => {
  it('walks upload → propose → detect → dry run → start → completed', async () => {
    const authFetch = api({
      'POST /sources': { ...SOURCE, content: undefined },
      'POST /propose/recipe': { recipe: RECIPE, linkRules: [], origin: 'model', notes: ['OwnerEmail looks like an e-mail address.'], timing: { ms: 900 } },
      'GET /propose/status': { configured: true, available: true, model: 'local', loaded: true },
      'POST /links/detect': { candidates: CANDIDATES },
      'POST /runs/dry-run': REPORT,
      'POST /profiles': { id: 11, name: 'Contoso projects', version: 1 },
      'POST /runs': jsonResponse({ id: 'run-1', status: 'queued' }, { status: 202 }),
      'GET /runs/run-1': { id: 'run-1', status: 'completed', stats: { rows: 3, entities: { byType: { Project: 3, Owner: 2 } }, links: { linked: 2, proposed: 0, none: 0 } } },
    });
    const onClose = render(authFetch);

    // 1 Start
    expect(screen.getByRole('radio', { name: /New import/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Full/ })).toBeChecked();
    await next();

    // 2 Source
    expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled();
    await upload();
    expect(screen.getByLabelText('Observed on')).toHaveValue('2026-09-30');
    const name = screen.getByRole('textbox', { name: 'Display name' });
    expect(name).toHaveValue('projects.csv');
    await userEvent.clear(name);
    await userEvent.type(name, 'Contoso projects');
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByText(/3 rows, 4 columns/)).toBeInTheDocument();
    const form = authFetch.mock.calls[0][1].body;
    expect(form.get('kind')).toBe('list');
    expect(form.get('displayName')).toBe('Contoso projects');
    expect(form.get('observedAt')).toBe('2026-09-30');
    expect(form.get('file').name).toBe('projects.csv');
    expect(authFetch.mock.calls[0][1].headers).toBeUndefined();
    expect(within(screen.getByRole('list', { name: 'Columns' })).getAllByRole('listitem')).toHaveLength(4);
    await next();

    // 3 Model
    expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Propose' }));
    expect(await screen.findByText(/Proposed by the model/)).toBeInTheDocument();
    expect(screen.getByText('OwnerEmail looks like an e-mail address.')).toBeInTheDocument();
    expect(bodyOf(authFetch, 'POST /propose/recipe')).toEqual({ fileName: 'projects.csv', columns: COLUMNS, rowCount: 3 });
    expect(screen.queryByText(/Proposing from column names only/)).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Entity 2 type' })).toHaveValue('Owner');
    expect(screen.getByRole('combobox', { name: 'Owner name column' })).toHaveValue('OwnerName');
    await next();

    // 4 Links
    await userEvent.click(screen.getByRole('button', { name: 'Detect candidates for Owner' }));
    const accept = await screen.findByRole('button', { name: 'Accept: email matches 94 % unique on Principal.email (exact)' });
    expect(bodyOf(authFetch, 'POST /links/detect')).toEqual({ sourceId: 'src-1', recipe: RECIPE, entityType: 'Owner' });
    await userEvent.click(accept);
    expect(screen.getByRole('spinbutton', { name: 'Weight of email → email (exact)' })).toHaveValue(90);
    expect(screen.getByText(/No link rule: Project entries/)).toBeInTheDocument();
    await next();

    // 5 Quality
    expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Run check' }));
    expect(await screen.findByText('The import can start.')).toBeInTheDocument();
    expect(bodyOf(authFetch, 'POST /runs/dry-run')).toEqual({
      sourceId: 'src-1', recipe: RECIPE, mode: 'full',
      linkRules: [{ entityType: 'Owner', targetType: 'Principal', threshold: 50, signals: [{ attribute: 'email', targetField: 'email', type: 'exact', weight: 90 }] }],
    });
    expect(within(screen.getByRole('region', { name: 'Quality of Owner' })).getByText('2 unique · 0 ambiguous · 0 none')).toBeInTheDocument();
    await next();

    // 6 Confirm
    const start = screen.getByRole('button', { name: 'Start import' });
    expect(start).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Profile name' }), 'Contoso projects');
    await userEvent.click(start);
    expect(bodyOf(authFetch, 'POST /profiles')).toMatchObject({ name: 'Contoso projects', sourceKind: 'list', recipe: RECIPE });
    expect(bodyOf(authFetch, 'POST /runs')).toEqual({ sourceId: 'src-1', profileId: 11, mode: 'full' });
    expect(await screen.findByText(/Import completed: 3 rows; 3 Project, 2 Owner; 2 linked/, {}, { timeout: 4000 })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('keeps the editor usable when the proposal is not available, and the step-1 cancel closes without import', async () => {
    const authFetch = api({
      'POST /sources': SOURCE,
      'POST /propose/recipe': jsonResponse({ error: 'Not implemented' }, { ok: false, status: 501 }),
      'GET /propose/status': { configured: false, available: false, reason: 'no model URL configured' },
    });
    const onClose = render(authFetch);
    await next();
    await upload();
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await screen.findByText(/3 rows/);
    await next();
    expect(await screen.findByText('Proposing from column names only: the local model is not available (no model URL configured).')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Propose' }));
    expect(await screen.findByText(/not available yet on this server\. Describe the entities yourself/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '+ Add entity' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Entity 1 type' }), 'Project');
    expect(screen.getByRole('list', { name: 'Recipe problems' })).toHaveTextContent('Entity 1 has no name column.');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Project name column' }), 'ProjectName');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Project key column' }), 'ProjectCode');
    await userEvent.click(screen.getByRole('button', { name: '+ Add attribute' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Project attribute column' }), 'OwnerEmail');
    await userEvent.type(screen.getByRole('textbox', { name: 'Project attribute name' }), 'ownerMail');
    await userEvent.click(screen.getByRole('button', { name: '+ Add relation' }));
    expect(screen.getByRole('list', { name: 'Recipe problems' })).toHaveTextContent('Relation 1 has no predicate.');
    await userEvent.type(screen.getByRole('textbox', { name: 'Relation predicate' }), 'parent');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Relation to' }), 'Project');
    expect(screen.queryByRole('list', { name: 'Recipe problems' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Next →' })).toBeEnabled();

    // removing the relation row and the entity leaves an empty recipe again
    await userEvent.click(screen.getAllByTitle('Remove').at(-1));
    await userEvent.click(screen.getByRole('button', { name: 'Remove Project' }));
    expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('shows an upload failure in the wizard and a proposal failure as a notice', async () => {
    let uploads = 0;
    const authFetch = api({
      'POST /sources': () => (++uploads === 1 ? jsonResponse({ error: 'The file is not a list.' }, { ok: false, status: 400 }) : SOURCE),
      'POST /propose/recipe': jsonResponse({ error: 'Source not found' }, { ok: false, status: 400 }),
    });
    render(authFetch);
    await next();
    expect(screen.getByText('Choose the list to import.')).toBeInTheDocument();
    await upload('broken.xlsx');
    await userEvent.clear(screen.getByLabelText('Observed on'));
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByText('Upload failed: The file is not a list.')).toBeInTheDocument();
    expect(authFetch.mock.calls[0][1].body.get('observedAt')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await screen.findByText(/3 rows/);
    await next();
    expect(screen.queryByText(/Upload failed/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Propose' }));
    expect(await screen.findByText('The proposal failed: Source not found')).toBeInTheDocument();
  });
});

// Drives a new import to step 4 with the recipe proposed and one rule accepted.
async function toLinks(authFetch) {
  render(authFetch);
  await next();
  await upload();
  await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
  await screen.findByText(/3 rows/);
  await next();
  await userEvent.click(screen.getByRole('button', { name: 'Propose' }));
  await screen.findByText(/Proposed from the column names/);
  await next();
}

describe('ImportWizard — links and quality', () => {
  const base = {
    'POST /sources': SOURCE,
    'POST /propose/recipe': { recipe: RECIPE, linkRules: PROFILE.linkRules, origin: 'heuristic', notes: [] },
  };

  it('edits signals, retargets a rule, and reports detection that finds nothing or fails', async () => {
    let detects = 0;
    const authFetch = api({
      ...base,
      'POST /links/detect': () => (++detects === 1 ? [] : jsonResponse({}, { ok: false, status: 501 })),
    });
    await toLinks(authFetch);
    const weight = screen.getByRole('spinbutton', { name: 'Weight of email → email (exact)' });
    fireEvent.change(weight, { target: { value: '70' } });
    expect(weight).toHaveValue(70);

    await userEvent.click(screen.getByRole('button', { name: 'Detect candidates for Project' }));
    expect(await screen.findByText('No attribute of Project matches a system field uniquely.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Detect candidates for Owner' }));
    expect(await screen.findByText(/not available yet on this server/)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Owner links to' }), 'Identity');
    expect(screen.getByText('email → Identity.email (exact)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove email → email (exact)' }));
    expect(screen.getByText(/No link rule: Owner entries/)).toBeInTheDocument();
  });

  it('blocks on a rule with no unique match, marks the report stale on a threshold change, and goes back to links', async () => {
    const bad = { ...REPORT, links: { Owner: { total: 2, unique: 0, ambiguous: 1, none: 1,
      samples: { ambiguous: [{ displayName: 'J. Doe', candidates: [{ label: 'jdoe', confidence: 60 }, { label: 'jdoe2', confidence: 60 }] }], none: [{ displayName: 'Nobody' }] } } },
      wouldClose: { Project: 2 } };
    let checks = 0;
    const authFetch = api({
      ...base,
      'POST /runs/dry-run': () => (++checks === 1 ? bad : jsonResponse({ error: 'Invalid recipe', errors: ['Entity 1 has no type.'] }, { ok: false, status: 400 })),
    });
    await toLinks(authFetch);
    await next();
    await userEvent.click(screen.getByRole('button', { name: 'Run check' }));
    expect(await screen.findByText(/^No Owner matched uniquely/)).toBeInTheDocument();
    expect(screen.getByText('J. Doe: jdoe (60 %), jdoe2 (60 %)')).toBeInTheDocument();
    expect(screen.getByText('Nobody')).toBeInTheDocument();
    expect(screen.getByText(/2 closed by a full import/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled();

    const slider = screen.getByRole('slider', { name: 'Link certainty threshold (percent)' });
    fireEvent.change(slider, { target: { value: '70' } });
    expect(screen.getByText('≥ 70%')).toBeInTheDocument();
    expect(screen.getByText(/The threshold changed since this check/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Re-run check' }));
    expect(await screen.findByText('The check failed: Invalid recipe Entity 1 has no type.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back to links' }));
    expect(screen.getByRole('region', { name: 'Links for Owner' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Go to step 2: Source' }));
    expect(screen.getByLabelText('Choose file')).toBeInTheDocument();
  });
});

describe('ImportWizard — repeat', () => {
  it('repeats a profile as a delta run without adjusting: skips the model and reuses the profile', async () => {
    const authFetch = api({
      'GET /profiles?latest=1': { profiles: [{ ...PROFILE, version: 2, id: 6 }, PROFILE, { id: 9, name: 'Northwind assets', version: 1, recipe: RECIPE, linkRules: [] }] },
      'POST /sources': SOURCE,
      'POST /runs/dry-run': REPORT,
      'POST /runs': jsonResponse({ id: 'run-2', status: 'failed', error: 'Source vanished' }, { status: 202 }),
    });
    const onClose = render(authFetch);
    await userEvent.click(screen.getByRole('radio', { name: /Repeat an earlier import/ }));
    expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled();
    const picker = await screen.findByRole('combobox', { name: 'Import profile' });
    expect(within(picker).getAllByRole('option').map(o => o.textContent)).toEqual(['Choose a profile…', 'Contoso projects (version 3)', 'Northwind assets (version 1)']);
    await userEvent.selectOptions(picker, '7');
    await userEvent.click(screen.getByRole('radio', { name: /Delta/ }));
    await next();

    expect(screen.queryByRole('button', { name: /Model/ })).toBeNull();
    expect(screen.queryByText('Model')).toBeNull();
    await upload();
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await screen.findByText(/3 rows/);
    await next();
    expect(screen.getByRole('region', { name: 'Links for Owner' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '← Back' }));
    expect(screen.getByText(/3 rows/)).toBeInTheDocument();
    await next();
    await next();
    await userEvent.click(screen.getByRole('button', { name: 'Run check' }));
    await screen.findByText('The import can start.');
    expect(bodyOf(authFetch, 'POST /runs/dry-run').mode).toBe('delta');
    await next();

    expect(screen.getByText('Uses Contoso projects version 3.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Profile name' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Start import' }));
    expect(await screen.findByText('The import failed: Source vanished')).toBeInTheDocument();
    expect(bodyOf(authFetch, 'POST /runs')).toEqual({ sourceId: 'src-1', profileId: 7, mode: 'delta' });
    expect(authFetch.mock.calls.some(([u, o]) => u.includes('/profiles') && o?.method)).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('repeat with adjust: the model step is prefilled, flags vanished columns, and saves a new version', async () => {
    const narrow = { ...SOURCE, columns: COLUMNS.filter(c => c.name !== 'OwnerEmail') };
    const authFetch = api({
      'GET /profiles?latest=1': [PROFILE],
      'POST /sources': narrow,
      'POST /runs/dry-run': REPORT,
      'PUT /profiles/7': jsonResponse({ error: 'Invalid link rules', errors: ['Link rule 1 ("Owner") signal 1 uses attribute "email".'] }, { ok: false, status: 400 }),
    });
    render(authFetch);
    await userEvent.click(screen.getByRole('radio', { name: /Repeat an earlier import/ }));
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Import profile' }), '7');
    await userEvent.click(screen.getByRole('checkbox', { name: /Adjust the configuration/ }));
    await next();
    await upload();
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await screen.findByText(/3 rows, 3 columns/);
    await next();

    expect(screen.getByRole('textbox', { name: 'Entity 1 type' })).toHaveValue('Project');
    expect(screen.getByText('The list no longer has these columns the profile uses: OwnerEmail.')).toBeInTheDocument();
    await next();
    await next();
    await userEvent.click(screen.getByRole('button', { name: 'Run check' }));
    await screen.findByText('The import can start.');
    await next();
    expect(screen.getByText('Saves version 4 of Contoso projects.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start import' }));
    expect(await screen.findByText(/Could not save the import profile: Invalid link rules Link rule 1/)).toBeInTheDocument();
    expect(bodyOf(authFetch, 'PUT /profiles/7').name).toBe('Contoso projects');
  });

  it('says so when there is nothing to repeat, or the profiles route is not built', async () => {
    render(api({ 'GET /profiles?latest=1': [] }));
    await userEvent.click(screen.getByRole('radio', { name: /Repeat an earlier import/ }));
    expect(await screen.findByText(/There is no earlier import to repeat yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: /New import/ }));
    expect(screen.getByRole('button', { name: 'Next →' })).toBeEnabled();
  });

  it('treats a 501 on the profiles list as no profiles yet', async () => {
    render(api({ 'GET /profiles?latest=1': jsonResponse({}, { ok: false, status: 501 }) }));
    await userEvent.click(screen.getByRole('radio', { name: /Repeat an earlier import/ }));
    expect(await screen.findByText(/There is no earlier import to repeat yet/)).toBeInTheDocument();
  });

  it('shows other profile-list errors as such, and clearing the picker un-chooses', async () => {
    render(api({ 'GET /profiles?latest=1': jsonResponse({}, { ok: false, status: 500 }) }));
    await userEvent.click(screen.getByRole('radio', { name: /Repeat an earlier import/ }));
    expect(await screen.findByText('Could not load the import profiles: HTTP 500')).toBeInTheDocument();
  });

  it('un-choosing the profile disables Next again', async () => {
    render(api({ 'GET /profiles?latest=1': [PROFILE] }));
    await userEvent.click(screen.getByRole('radio', { name: /Repeat an earlier import/ }));
    const picker = await screen.findByRole('combobox', { name: 'Import profile' });
    await userEvent.selectOptions(picker, '7');
    expect(screen.getByRole('button', { name: 'Next →' })).toBeEnabled();
    await userEvent.selectOptions(picker, '');
    expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled();
  });

  it('opens on the profile given by profileId, or reports why it cannot', async () => {
    render(api({ 'GET /profiles/7': PROFILE, 'GET /profiles?latest=1': [PROFILE] }), { profileId: 7 });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Import profile' })).toHaveValue('7'));
    expect(screen.getByRole('button', { name: 'Next →' })).toBeEnabled();
  });

  it('reports a profileId that cannot be loaded', async () => {
    render(api({ 'GET /profiles?latest=1': [PROFILE] }), { profileId: 99 });
    expect(await screen.findByText('Could not load the import profile: not stubbed')).toBeInTheDocument();
  });
});
