// @vitest-environment jsdom
//
// The import wizard end to end against authFetch stubs: a new import of a
// collection (upload → kind → propose → detect → dry run → start → completed),
// a repeat with and without adjusting, a repeat opened by profileId, and the
// "not available yet" path a live 501 takes. The other three templates are in
// ImportWizard.templates.mount.test.jsx.
import { describe, it, expect } from 'vitest';
import { jsonResponse, screen, userEvent, waitFor, within, fireEvent } from '@ui/test-utils/renderWithProviders';
import { api, bodyOf, next, proposeCalls, renderWizard as render, upload } from '@ui/test-utils/importWizardKit';

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
  links: { 'Owner → Principal via email': { entityType: 'Owner', targetType: 'Principal', via: 'email', total: 2, unique: 2, ambiguous: 0, none: 0, samples: { ambiguous: [], none: [] } } },
  wouldClose: {}, issues: [],
};
const PROFILE = {
  id: 7, name: 'Contoso projects', version: 3, recipe: RECIPE,
  linkRules: [{ entityType: 'Owner', targetType: 'Principal', via: 'email', threshold: 50, signals: [{ attribute: 'email', targetField: 'email', type: 'exact', weight: 90 }] }],
};


describe('ImportWizard — new import', () => {
  it('walks upload → propose → detect → dry run → start → completed', async () => {
    let release;
    const held = new Promise(res => { release = res; });
    const authFetch = api({
      'POST /sources': { ...SOURCE, content: undefined },
      'POST /propose/recipe': () => held,
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

    // 3 Kind
    // the proposal runs on entering the step, no click needed; the cards wait for it
    expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled();
    expect(screen.getByText('Proposing…')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Activity/ })).toBeDisabled();
    release({
      recipe: RECIPE, linkRules: [], origin: 'model', notes: ['OwnerEmail looks like an e-mail address.'], timing: { ms: 900 },
      template: { kind: 'collection', confidence: 84, reason: 'A name column with owner columns that match accounts.', alternatives: ['enrichment'] },
    });
    expect(await screen.findByText('A name column with owner columns that match accounts.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Collection/ })).toBeChecked();
    expect(screen.getByText('Proposed · 84 %')).toBeInTheDocument();
    // the collection path sends no template: the server proposes the kind
    expect(bodyOf(authFetch, 'POST /propose/recipe')).toEqual({ fileName: 'projects.csv', columns: COLUMNS, rowCount: 3, sourceId: 'src-1' });
    await next();

    // 4 Model
    expect(await screen.findByText(/Proposed by the model/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Propose again' })).toBeEnabled();
    expect(screen.getByText('OwnerEmail looks like an e-mail address.')).toBeInTheDocument();
    expect(screen.queryByText(/Proposing from column names only/)).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Entity 2 type' })).toHaveValue('Owner');
    expect(screen.getByRole('combobox', { name: 'Owner name column' })).toHaveValue('OwnerName');
    await userEvent.type(screen.getByRole('textbox', { name: 'Owner name attribute' }), 'manager');
    const SENT = { ...RECIPE, entities: [RECIPE.entities[0], { ...RECIPE.entities[1], nameAttribute: 'manager' }] };
    expect(proposeCalls(authFetch)).toBe(1); // edits re-render, they do not propose again
    await next();

    // 5 Links
    await userEvent.click(screen.getByRole('button', { name: 'Detect candidates for Owner' }));
    const accept = await screen.findByRole('button', { name: 'Accept: email matches 94 % unique on Principal.email (exact)' });
    expect(bodyOf(authFetch, 'POST /links/detect')).toEqual({ sourceId: 'src-1', recipe: SENT, entityType: 'Owner' });
    await userEvent.click(accept);
    expect(screen.getByRole('spinbutton', { name: 'Weight of email → email (exact) in email → Principal' })).toHaveValue(90);
    expect(screen.getByText(/No link rule: Project entries/)).toBeInTheDocument();
    await next();

    // 6 Quality
    expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Run check' }));
    expect(await screen.findByText('The import can start.')).toBeInTheDocument();
    expect(bodyOf(authFetch, 'POST /runs/dry-run')).toEqual({
      sourceId: 'src-1', recipe: SENT, mode: 'full',
      linkRules: [{ entityType: 'Owner', targetType: 'Principal', via: 'email', threshold: 50, signals: [{ attribute: 'email', targetField: 'email', type: 'exact', weight: 90 }] }],
    });
    const ownerCard = within(screen.getByRole('region', { name: 'Quality of Owner' }));
    expect(ownerCard.getByText('2 unique · 0 ambiguous · 0 none')).toBeInTheDocument();
    expect(ownerCard.getByText('Owner.email → Principal · 2 values')).toBeInTheDocument();
    await next();

    // 7 Confirm
    expect(screen.getByText('Kind', { selector: 'dt' }).nextSibling).toHaveTextContent('Collection');
    const start = screen.getByRole('button', { name: 'Start import' });
    expect(start).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Profile name' }), 'Contoso projects');
    await userEvent.click(start);
    expect(bodyOf(authFetch, 'POST /profiles')).toEqual(expect.objectContaining({ name: 'Contoso projects', sourceKind: 'list', recipe: SENT }));
    expect(bodyOf(authFetch, 'POST /runs')).toEqual({ sourceId: 'src-1', profileId: 11, mode: 'full' });
    expect(await screen.findByText(/Import completed: 3 rows; 3 Project, 2 Owner; 2 linked/, {}, { timeout: 4000 })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledWith(true);
  }, 15000); // seven steps of clicks; slow under a parallel run

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
    expect(await screen.findByText(/not available yet on this server\. Pick the kind yourself/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Collection/ })).toBeChecked();
    expect(proposeCalls(authFetch)).toBe(1);
    await next();
    expect(await screen.findByText('Proposing from column names only: the local model is not available (no model URL configured).')).toBeInTheDocument();
    // the model step does not propose again on its own after a failed proposal
    expect(proposeCalls(authFetch)).toBe(1);
    await userEvent.click(screen.getByRole('button', { name: 'Propose again' }));
    await waitFor(() => expect(proposeCalls(authFetch)).toBe(2));
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
    // an emptied draft after a failed run does not propose again on its own
    expect(proposeCalls(authFetch)).toBe(2);

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
    expect(await screen.findByText('The proposal failed: Source not found')).toBeInTheDocument();
  });
});

// Drives a new import to step 5 with the recipe proposed and one rule accepted.
async function toLinks(authFetch) {
  render(authFetch);
  await next();
  await upload();
  await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
  await screen.findByText(/3 rows/);
  await next();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next →' })).toBeEnabled());
  await next();
  await screen.findByText(/Proposed from the column names/);
  await next();
}

describe('ImportWizard — links and quality', () => {
  const base = {
    'POST /sources': SOURCE,
    'POST /propose/recipe': { recipe: RECIPE, linkRules: PROFILE.linkRules, origin: 'heuristic', notes: [] },
  };

  it('edits signals, removes the last signal of a rule, and reports detection that finds nothing or fails', async () => {
    let detects = 0;
    const authFetch = api({
      ...base,
      'POST /links/detect': () => (++detects === 1 ? [] : jsonResponse({}, { ok: false, status: 501 })),
    });
    await toLinks(authFetch);
    const weight = screen.getByRole('spinbutton', { name: 'Weight of email → email (exact) in email → Principal' });
    fireEvent.change(weight, { target: { value: '70' } });
    expect(weight).toHaveValue(70);

    await userEvent.click(screen.getByRole('button', { name: 'Detect candidates for Project' }));
    expect(await screen.findByText('No attribute of Project matches a system field uniquely.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Detect candidates for Owner' }));
    expect(await screen.findByText(/not available yet on this server/)).toBeInTheDocument();

    expect(screen.queryByRole('combobox', { name: /links to/ })).toBeNull();
    expect(screen.getByText('email → Principal.email (exact)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove email → email (exact) from email → Principal' }));
    expect(screen.getByText(/No link rule: Owner entries/)).toBeInTheDocument();
  });

  it('one entity links its owner and team to accounts and its own name to a resource, as separate rules', async () => {
    const candidates = [
      { attribute: 'owner', targetType: 'Principal', targetField: 'email', type: 'exact', unique: 50, multiple: 2, none: 6, uniquePct: 86, suggestedWeight: 85 },
      { attribute: 'team', targetType: 'Principal', targetField: 'email', type: 'exact', unique: 28, multiple: 1, none: 3, uniquePct: 88, suggestedWeight: 80 },
      { attribute: 'displayName', targetType: 'Resource', targetField: 'displayName', type: 'name', unique: 40, multiple: 4, none: 14, uniquePct: 69, suggestedWeight: 60 },
    ];
    const report = { ...REPORT, links: {
      'Project → Principal via owner': { entityType: 'Project', targetType: 'Principal', via: 'owner', total: 58, unique: 50, ambiguous: 2, none: 6 },
      'Project → Principal via team': { entityType: 'Project', targetType: 'Principal', via: 'team', total: 32, unique: 28, ambiguous: 1, none: 3 },
      'Project → Resource via displayName': { entityType: 'Project', targetType: 'Resource', via: 'displayName', total: 58, unique: 0, ambiguous: 4, none: 54 },
    } };
    const authFetch = api({ ...base, 'POST /links/detect': { candidates }, 'POST /runs/dry-run': report });
    await toLinks(authFetch);
    await userEvent.click(screen.getByRole('button', { name: 'Detect candidates for Project' }));
    for (const c of candidates) {
      const what = c.attribute === 'displayName' ? 'Project name' : c.attribute;
      await userEvent.click(await screen.findByRole('button', { name: `Accept: ${what} matches ${c.uniquePct} % unique on ${c.targetType}.${c.targetField} (${c.type})` }));
    }
    const project = within(screen.getByRole('region', { name: 'Links for Project' }));
    expect(project.getAllByRole('heading', { level: 5 }).map(h => h.textContent)).toEqual(['owner → Principal', 'team → Principal', 'Project name → Resource']);
    expect(project.getByRole('spinbutton', { name: 'Weight of team → email (exact) in team → Principal' })).toHaveValue(80);

    // removing one rule leaves the two others and Owner's rule untouched
    await userEvent.click(project.getByRole('button', { name: 'Remove rule owner → Principal' }));
    expect(project.getAllByRole('heading', { level: 5 }).map(h => h.textContent)).toEqual(['team → Principal', 'Project name → Resource']);
    expect(screen.getByRole('region', { name: 'Rule email → Principal' })).toBeInTheDocument();

    await next();
    await userEvent.click(screen.getByRole('button', { name: 'Run check' }));
    expect(await screen.findByText(/^No Project name → Resource value matched uniquely/)).toBeInTheDocument();
    expect(bodyOf(authFetch, 'POST /runs/dry-run').linkRules.map(r => `${r.entityType}|${r.targetType}|${r.via}`))
      .toEqual(['Owner|Principal|email', 'Project|Principal|team', 'Project|Resource|displayName']);
    const card = within(screen.getByRole('region', { name: 'Quality of Project' }));
    expect(card.getByText('Project.team → Principal · 32 values')).toBeInTheDocument();
    expect(card.getByText('Project name → Resource · 58 values')).toBeInTheDocument();
    expect(card.getAllByRole('group')).toHaveLength(3);
    expect(within(screen.getByRole('region', { name: 'Quality of Owner' })).queryAllByRole('group')).toHaveLength(0);
  });

  it('blocks on a rule with no unique match, marks the report stale on a threshold change, and goes back to links', async () => {
    const bad = { ...REPORT, links: { 'Owner → Principal via email': { entityType: 'Owner', targetType: 'Principal', via: 'email', total: 2, unique: 0, ambiguous: 1, none: 1,
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
    expect(await screen.findByText(/^No Owner\.email → Principal value matched uniquely/)).toBeInTheDocument();
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
    expect(screen.queryByText('Kind')).toBeNull();
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
    expect(proposeCalls(authFetch)).toBe(0);
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
    // the profile's kind is preselected, nothing proposed
    expect(screen.getByRole('radio', { name: /Collection/ })).toBeChecked();
    expect(screen.queryByText(/^Proposed/)).toBeNull();
    await next();

    expect(screen.getByRole('textbox', { name: 'Entity 1 type' })).toHaveValue('Project');
    expect(screen.getByText('The list no longer has these columns the profile uses: OwnerEmail.')).toBeInTheDocument();
    // the profile's recipe is not overwritten by an automatic proposal
    expect(proposeCalls(authFetch)).toBe(0);
    expect(screen.getByRole('button', { name: 'Propose again' })).toBeEnabled();
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
