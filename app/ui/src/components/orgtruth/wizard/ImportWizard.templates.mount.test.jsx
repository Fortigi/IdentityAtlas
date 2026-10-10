// @vitest-environment jsdom
//
// The import wizard for the three non-collection templates, against authFetch
// stubs: the "What kind of list is this?" step (proposed kind preselected with
// its reason, another card re-proposes with { template }), each template's
// mapping step, the exact recipe each one sends, the steps it skips, and the
// activity run summary. The collection path is ImportWizard.mount.test.jsx.
// Each walk clicks through most of the wizard, hence the 15 s timeouts.
import { describe, it, expect } from 'vitest';
import { jsonResponse, screen, userEvent, waitFor, within } from '@ui/test-utils/renderWithProviders';
import { api, bodiesOf, bodyOf, next, renderWizard, upload } from '@ui/test-utils/importWizardKit';

const COLUMNS = ['Employee', 'Customer', 'Year', 'Month', 'Date', 'Hours', 'Skills', 'Project', 'RoleA', 'RoleB'].map(name => ({ name, shape: 'text' }));
const SOURCE = { id: 'src-9', displayName: 'Contoso hours', fileName: 'hours.xlsx', rowCount: 40, columns: COLUMNS };
const MODEL = { entityTypes: [
  { type: 'Client', template: 'collection', count: 14 }, { type: 'Expertise', template: 'enrichment', count: 60 }, { type: 'Project', count: 9 },
] };
const COLLECTION_PROPOSAL = {
  recipe: { version: 1, entities: [{ type: 'Hours', nameColumn: 'Customer', attributes: [] }], relations: [] }, linkRules: [], origin: 'data', notes: [],
  template: { kind: 'collection', confidence: 55, reason: 'Customer looks like a list of names.', alternatives: ['activity', 'relation'] },
};

const nextEnabled = () => waitFor(() => expect(screen.getByRole('button', { name: 'Next →' })).toBeEnabled());
const combo = (name) => screen.getByRole('combobox', { name });

// Start → upload → the kind step, with the first proposal answered.
async function toKind(authFetch) {
  const onClose = renderWizard(authFetch);
  await next();
  await upload('hours.xlsx');
  await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
  await screen.findByText(/40 rows, 10 columns/);
  await next();
  await nextEnabled();
  return onClose;
}

describe('ImportWizard — activity', () => {
  const ACTIVITY_PROPOSAL = {
    recipe: { version: 1, template: 'activity', activity: {
      type: 'Hours', actor: { column: 'Employee', targetTypes: ['Principal', 'Identity'] }, subject: { column: 'Customer', targetType: 'Resource' },
      when: { dateColumn: 'Date' }, measure: { column: 'Hours', unit: '' }, attributes: [],
    } },
    linkRules: [], origin: 'data', notes: [], template: { kind: 'activity', confidence: 100, reason: 'Chosen by the analyst.' },
  };
  const SENT = {
    version: 1, template: 'activity',
    activity: {
      type: 'Hours', actor: { column: 'Employee', targetTypes: ['Principal', 'Identity'] },
      subject: { column: 'Customer', targetType: 'OrgEntity', targetEntityType: 'Client' },
      when: { yearColumn: 'Year', monthColumn: 'Month' }, measure: { column: 'Hours', unit: 'h' },
      attributes: [{ column: 'Project', name: 'project' }],
    },
  };
  const KEYS = { actor: { total: 3, accepted: 2, proposed: 0, unmatched: 1 }, subject: { total: 2, accepted: 2, proposed: 0, unmatched: 0 } };
  const REPORT = {
    rows: 40, activities: 40, skipped: 0, keys: KEYS,
    sample: [{ actor: 'Ann Example', subject: 'Contoso', occurredOn: '2026-03-01', periodEnd: '2026-03-31', measure: 7.5, unit: 'h' }],
  };

  it('re-proposes as an activity, maps it, previews the parsed rows, skips links and reports the key counts', async () => {
    const authFetch = api({
      'POST /sources': SOURCE,
      'POST /propose/recipe': (opts) => (JSON.parse(opts.body).template === 'activity' ? ACTIVITY_PROPOSAL : COLLECTION_PROPOSAL),
      'GET /model': MODEL,
      'POST /runs/dry-run': REPORT,
      'POST /profiles': { id: 21, name: 'Contoso hours', version: 1 },
      'POST /runs': jsonResponse({ id: 'run-7', status: 'queued' }, { status: 202 }),
      'GET /runs/run-7': { id: 'run-7', status: 'completed', stats: { rows: 40, activities: 40, skipped: 0, keys: KEYS } },
    });
    await toKind(authFetch);

    // 3 Kind: the proposed collection is preselected; picking Activity re-proposes with the template
    expect(screen.getByRole('radio', { name: /Collection/ })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: /Activity/ }));
    await nextEnabled();
    expect(bodiesOf(authFetch, 'POST /propose/recipe')).toEqual([
      { fileName: 'hours.xlsx', columns: COLUMNS, rowCount: 40, sourceId: 'src-9' },
      { fileName: 'hours.xlsx', columns: COLUMNS, rowCount: 40, sourceId: 'src-9', template: 'activity' },
    ]);
    expect(screen.getByRole('radio', { name: /Activity/ })).toBeChecked();
    // the data's suggestion stays marked on its own card
    expect(screen.getByText('Customer looks like a list of names.')).toBeInTheDocument();
    expect(screen.getByText('Proposed · 55 %')).toBeInTheDocument();
    await next();

    // 4 Activity mapping, prefilled from the forced proposal
    expect(combo('Actor column')).toHaveValue('Employee');
    expect(combo('Date column')).toHaveValue('Date');
    expect(within(combo('Subject refers to')).getAllByRole('option').map(o => o.textContent))
      .toEqual(['Choose…', 'Resource', 'Client (collection)', 'Project (collection)']);
    await userEvent.selectOptions(combo('Subject refers to'), 'OrgEntity:Client');
    await userEvent.click(screen.getByRole('radio', { name: /Year and month columns/ }));
    expect(screen.getByRole('list', { name: 'Recipe problems' })).toHaveTextContent('Choose when each row happened');
    expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled();
    await userEvent.selectOptions(combo('Year column'), 'Year');
    await userEvent.selectOptions(combo('Month column'), 'Month');
    await userEvent.type(screen.getByRole('textbox', { name: 'Unit' }), 'h');
    await userEvent.click(screen.getByRole('button', { name: '+ Add attribute' }));
    await userEvent.selectOptions(combo('Activity attribute column'), 'Project');
    await userEvent.type(screen.getByRole('textbox', { name: 'Activity attribute name' }), 'project');
    expect(screen.queryByRole('list', { name: 'Recipe problems' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Preview the first rows' }));
    const preview = within(await screen.findByRole('region', { name: 'Activity preview' }));
    expect(bodyOf(authFetch, 'POST /runs/dry-run')).toEqual({ sourceId: 'src-9', recipe: SENT, linkRules: [], mode: 'full' });
    expect(preview.getAllByRole('cell').map(c => c.textContent)).toEqual(['Ann Example', 'Contoso', '2026-03-01 – 2026-03-31', '7.5 h']);
    expect(preview.getByText('3 actor values: 2 matched, 0 proposed, 1 without a match')).toBeInTheDocument();
    await next();

    // 6 Quality (links skipped): the preview's report, no threshold, no way back to links
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back to links' })).toBeNull();
    expect(screen.getByText('1 of 3 actor values match nothing yet; review them after the import.')).toBeInTheDocument();
    expect(screen.getByText('The import can start.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '← Back' }));
    expect(combo('Year column')).toHaveValue('Year');
    await next();
    await next();

    // 7 Confirm
    expect(screen.getByText('Activity', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('Hours: Employee on Customer (Client)')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Profile name' }), 'Contoso hours');
    await userEvent.click(screen.getByRole('button', { name: 'Start import' }));
    expect(bodyOf(authFetch, 'POST /profiles')).toEqual({ name: 'Contoso hours', sourceKind: 'list', recipe: SENT, linkRules: [] });
    expect(bodyOf(authFetch, 'POST /runs')).toEqual({ sourceId: 'src-9', profileId: 21, mode: 'full' });
    expect(await screen.findByText('Import completed: 40 rows; 40 activities; 3 actor values: 2 matched, 0 proposed, 1 without a match; '
      + '2 subject values: 2 matched, 0 proposed, 0 without a match.', {}, { timeout: 4000 })).toBeInTheDocument();
  }, 15000);
});

describe('ImportWizard — enrichment', () => {
  const PROPOSAL = {
    recipe: { version: 1, template: 'enrichment', relations: [],
      entities: [{ type: 'Expertise', nameColumn: 'Customer', attributes: [{ column: 'Skills', name: 'expertises' }] }], enrich: { targetType: 'Identity' } },
    linkRules: [], origin: 'data', notes: [],
    template: { kind: 'enrichment', confidence: 92, reason: 'Employee matches accounts by e-mail; the other columns describe them.', alternatives: ['collection'] },
  };
  const SENT = {
    version: 1, template: 'enrichment',
    entities: [{ type: 'Expertise', nameColumn: 'Employee', attributes: [{ column: 'Skills', name: 'expertises', multi: true }, { column: 'Project' }] }],
    relations: [], enrich: { targetType: 'Principal' },
  };
  const toIdentity = { attribute: 'displayName', targetType: 'Identity', targetField: 'email', type: 'exact', unique: 30, multiple: 0, none: 10, uniquePct: 75, suggestedWeight: 80 };
  const toPrincipal = { ...toIdentity, targetType: 'Principal', unique: 38, none: 2, uniquePct: 95, suggestedWeight: 90 };

  it('maps the target, key column and a multi-valued attribute, and needs the rule to its target type', async () => {
    const authFetch = api({
      'POST /sources': SOURCE,
      'POST /propose/recipe': PROPOSAL,
      'POST /links/detect': { candidates: [toIdentity, toPrincipal] },
      'POST /runs/dry-run': { rows: 40, entities: { Expertise: { total: 40, duplicateKeys: 0, emptyKeys: 0 } },
        links: { r: { entityType: 'Expertise', targetType: 'Principal', via: 'displayName', total: 40, unique: 38, ambiguous: 0, none: 2 } } },
    });
    await toKind(authFetch);
    expect(screen.getByRole('radio', { name: /Enrichment/ })).toBeChecked();
    expect(screen.getByText('Employee matches accounts by e-mail; the other columns describe them.')).toBeInTheDocument();
    await next();

    // 4 Enrichment mapping
    expect(screen.getByRole('textbox', { name: 'List name' })).toHaveValue('Expertise');
    await userEvent.selectOptions(combo('Adds information to'), 'Principal');
    await userEvent.selectOptions(combo('Key column'), 'Employee');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Multiple values' }));
    await userEvent.click(screen.getByRole('button', { name: '+ Add attribute' }));
    const columnsSelects = screen.getAllByRole('combobox', { name: 'Expertise attribute column' });
    await userEvent.selectOptions(columnsSelects[1], 'Project');
    expect(screen.getAllByRole('checkbox', { name: 'Multiple values' }).map(c => c.checked)).toEqual([true, false]);
    await next();

    // 5 Links: Next waits for a rule to Principal; a rule to Identity does not count
    expect(screen.getByText('Required: a rule that links Expertise to Principal. Detect the candidates and accept one on Principal.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Detect candidates for Expertise' }));
    expect(bodyOf(authFetch, 'POST /links/detect')).toEqual({ sourceId: 'src-9', recipe: SENT, entityType: 'Expertise' });
    await userEvent.click(await screen.findByRole('button', { name: 'Accept: Expertise name matches 75 % unique on Identity.email (exact)' }));
    expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Accept: Expertise name matches 95 % unique on Principal.email (exact)' }));
    expect(screen.getByText(/Expertise is linked to Principal/)).toBeInTheDocument();
    await next();

    // 6 Quality: the threshold applies, both rules are sent
    expect(screen.getByRole('slider', { name: 'Link certainty threshold (percent)' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run check' }));
    await screen.findByText('The import can start.');
    const sent = bodyOf(authFetch, 'POST /runs/dry-run');
    expect(sent.recipe).toEqual(SENT);
    expect(sent.linkRules.map(r => `${r.entityType}|${r.targetType}|${r.via}|${r.signals[0].weight}`)).toEqual(['Expertise|Identity|displayName|80', 'Expertise|Principal|displayName|90']);
  }, 15000);
});

describe('ImportWizard — relation', () => {
  const SENT = {
    version: 1, template: 'relation',
    relation: {
      type: 'Incompatibility', predicate: 'incompatibleWith',
      left: { column: 'RoleA', targetType: 'Resource' },
      right: { column: 'RoleB', targetType: 'OrgEntity', targetEntityType: 'Project' },
      attributes: [],
    },
  };

  it('keeps the chosen kind when the re-proposal is not available, maps both ends and skips links', async () => {
    const authFetch = api({
      'POST /sources': SOURCE,
      'POST /propose/recipe': (opts) => (JSON.parse(opts.body).template ? jsonResponse({}, { ok: false, status: 501 }) : COLLECTION_PROPOSAL),
      'GET /model': MODEL,
      'POST /runs/dry-run': { rows: 40, entities: { Incompatibility: { total: 40, duplicateKeys: 0, emptyKeys: 0 } }, links: {} },
    });
    await toKind(authFetch);
    await userEvent.click(screen.getByRole('radio', { name: /Relation/ }));
    expect(await screen.findByText(/not available yet on this server\. Pick the kind yourself/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Relation/ })).toBeChecked();
    expect(screen.queryByText('Links')).toBeNull();
    await next();

    // 4 Relation mapping, from an empty recipe
    expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Relation name' }), 'Incompatibility');
    await userEvent.type(screen.getByRole('textbox', { name: 'Predicate' }), 'incompatibleWith');
    await userEvent.selectOptions(combo('Left column'), 'RoleA');
    expect(combo('Left refers to')).toHaveValue('Resource');
    await userEvent.selectOptions(combo('Right column'), 'RoleB');
    expect(within(combo('Right refers to')).getAllByRole('option').map(o => o.textContent))
      .toEqual(['Choose…', 'Resource', 'Principal', 'Identity', 'Client (collection)', 'Project (collection)']);
    await userEvent.selectOptions(combo('Right refers to'), 'OrgEntity:Project');
    await next();

    // 6 Quality straight after the mapping; no rules are sent
    await userEvent.click(screen.getByRole('button', { name: 'Run check' }));
    await screen.findByText('The import can start.');
    expect(bodyOf(authFetch, 'POST /runs/dry-run')).toEqual({ sourceId: 'src-9', recipe: SENT, linkRules: [], mode: 'full' });
    await next();
    expect(screen.getByText('Incompatibility: RoleA (Resource) incompatibleWith RoleB (Project)')).toBeInTheDocument();
  }, 15000);
});
