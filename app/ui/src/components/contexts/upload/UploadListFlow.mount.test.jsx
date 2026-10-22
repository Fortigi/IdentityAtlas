// @vitest-environment jsdom
// The "Upload a list" path of the New context tree wizard, mounted through the
// wizard itself: file → mapping (best guess, overridable, AI-marked) → preview →
// import, and the re-import entry that opens it on a chosen list.
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import NewContextWizard from '@ui/components/contexts/NewContextWizard';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, userEvent, within } from '@ui/test-utils/renderWithProviders';

vi.mock('@ui/hooks/useCanBuildContexts', () => ({ useCanBuildContexts: () => false }));

const LISTS = [{ id: 42, displayName: 'Klanten (upload)', fileName: 'klanten.xlsx', uploadedAt: '2026-10-01T10:00:00.000Z' }];
const GUESS = {
  template: 'OrganizationalUnit', listName: 'Klanten', nameColumn: 'Naam', keyColumn: 'Naam',
  ownerColumn: 'Eigenaar', responsibleColumn: null, parentColumn: null,
  memberColumns: [{ column: 'Gebruikers', kind: 'Principal', shape: 'list' }, { column: 'Applicaties', kind: 'Resource', shape: 'list' }],
  attributeColumns: ['Klantnummer', 'Sector'],
};
const ANALYSIS = {
  uploadDraftId: 'draft-1', fileName: 'klanten.csv', rowCount: 2, aiUsed: true, aiFields: ['ownerColumn'],
  columns: ['Klantnummer', 'Naam', 'Sector', 'Eigenaar', 'Gebruikers', 'Applicaties'].map(header => ({ header, samples: [`${header} 1`] })),
  guess: GUESS, existingList: null,
};
const PREVIEW = {
  rowCount: 2, unitCount: 2, trees: [{ name: 'Klanten', kind: 'Principal' }, { name: 'Klanten · Resources', kind: 'Resource' }],
  contexts: { created: 6, updated: 0, unchanged: 0, notInFile: 0 },
  members: { matched: 3, unmatched: 1, ambiguous: 0, unmatchedSamples: [{ kind: 'Principal', value: 'ghost@x.nl', reason: 'not found' }] },
  errors: [], warnings: ['Row 2: the parent "Z" of "Beta" is not in the list, so it goes directly under the root.'], sample: [],
};

function api(overrides = {}) {
  return makeAuthFetch({
    'uploads/analyze': ANALYSIS,
    'uploads/preview': PREVIEW,
    'uploads/apply': jsonResponse({ rootContextId: 'root-1', listId: 42 }, { ok: true, status: 201 }),
    '/api/contexts/uploads': { data: LISTS },
    'context-plugins': { data: [] },
    'systems': { data: [] },
    'contexts?variant=generated': { data: [] },
    ...overrides,
  });
}

function mount(props = {}, authFetch = api()) {
  const cb = { onClose: vi.fn(), onCreated: vi.fn(), ...props };
  renderWithProviders(h(NewContextWizard, { open: true, ...cb }), { auth: { authFetch } });
  return { ...cb, authFetch, user: userEvent.setup() };
}

const bodyOf = (authFetch, path) => JSON.parse(authFetch.mock.calls.find(([u]) => String(u).includes(path))[1].body);
const csvFile = () => new File(['Naam;Eigenaar\nAcme;o@x.nl'], 'klanten.csv', { type: 'text/csv' });

describe('Upload a list', () => {
  it('is the fourth way to start a tree, and its file step needs a file', async () => {
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: /^Upload a list/ }));
    expect(screen.getByText('Your own list of organisation units or applications')).toBeInTheDocument();
    await user.click(screen.getByText('Next ▸'));
    expect(await screen.findByLabelText('List file')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read the file ▸' })).toBeDisabled();
    // The lists uploaded before are offered for an update.
    const picker = screen.getByRole('combobox', { name: 'Update an existing list' });
    expect(within(picker).getByRole('option', { name: /^Klanten · last klanten\.xlsx/ })).toBeInTheDocument();
  });

  it('walks file → mapping → preview → import, with an override of the guess in the body sent', async () => {
    const { user, authFetch, onCreated, onClose } = mount();
    await user.click(await screen.findByRole('button', { name: /^Upload a list/ }));
    await user.click(screen.getByText('Next ▸'));
    await user.upload(await screen.findByLabelText('List file'), csvFile());
    await user.click(screen.getByRole('button', { name: 'Read the file ▸' }));

    // Mapping: the guess pre-filled, the AI's field marked, every field changeable.
    expect(await screen.findByText(/2 rows in klanten\.csv\. This is a best guess, partly by the AI/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Name' })).toHaveValue('Naam');
    expect(screen.getByRole('combobox', { name: 'Owner' })).toHaveValue('Eigenaar');
    expect(screen.getAllByTitle('Suggested by the AI — change it if it is wrong')).toHaveLength(1);
    expect(screen.getByText('Trees: Klanten and Klanten · Resources.')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Key' }), 'Klantnummer');
    await user.click(screen.getByRole('checkbox', { name: /^Sector/ }));
    await user.click(screen.getByRole('button', { name: 'Preview ▸' }));

    // The analyze call carried the file as multipart.
    const analyzeCall = authFetch.mock.calls.find(([u]) => String(u).includes('uploads/analyze'));
    expect(analyzeCall[1].body).toBeInstanceOf(FormData);
    expect(analyzeCall[1].body.get('file').name).toBe('klanten.csv');
    const sent = bodyOf(authFetch, 'uploads/preview');
    expect(sent).toEqual({ uploadDraftId: 'draft-1', mapping: { ...GUESS, keyColumn: 'Klantnummer', attributeColumns: [] } });

    // Preview: counts, members, the unmatched values and the warnings.
    expect(await screen.findByTestId('upload-counts')).toHaveTextContent('6 new · 0 changed · 0 unchanged');
    expect(screen.getByTestId('upload-members')).toHaveTextContent('Members: 3 matched · 1 not found');
    expect(screen.getByText(/ghost@x\.nl/)).toBeInTheDocument();
    expect(screen.getByText(/not in the list, so it goes directly under the root/)).toBeInTheDocument();
    // A new list has nothing to remove.
    expect(screen.queryByRole('checkbox', { name: /Remove units no longer in the file/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'root-1' }));
    expect(onClose).toHaveBeenCalled();
    expect(bodyOf(authFetch, 'uploads/apply')).toMatchObject({ uploadDraftId: 'draft-1', removeMissing: false });
  });

  it('a preview with row errors cannot be imported, and an API refusal shows its reasons', async () => {
    const authFetch = api({
      'uploads/preview': { ...PREVIEW, errors: ['Row 2: the key "K1" is also on row 1 with another name ("A" and "B").'] },
    });
    const { user } = mount({}, authFetch);
    await user.click(await screen.findByRole('button', { name: /^Upload a list/ }));
    await user.click(screen.getByText('Next ▸'));
    await user.upload(await screen.findByLabelText('List file'), csvFile());
    await user.click(screen.getByRole('button', { name: 'Read the file ▸' }));
    await user.click(await screen.findByRole('button', { name: 'Preview ▸' }));
    expect(await screen.findByText('These rows stop the import')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
  });

  it('an analyze refusal is shown and the wizard stays on the file step', async () => {
    const authFetch = api({ 'uploads/analyze': jsonResponse({ error: 'The file is empty.' }, { ok: false, status: 400 }) });
    const { user } = mount({}, authFetch);
    await user.click(await screen.findByRole('button', { name: /^Upload a list/ }));
    await user.click(screen.getByText('Next ▸'));
    await user.upload(await screen.findByLabelText('List file'), csvFile());
    await user.click(screen.getByRole('button', { name: 'Read the file ▸' }));
    expect(await screen.findByText('The file is empty.')).toBeInTheDocument();
    expect(screen.getByLabelText('List file')).toBeInTheDocument();
  });

  it('offers to update a list of the same name uploaded before, and then sends its id', async () => {
    const authFetch = api({ 'uploads/analyze': { ...ANALYSIS, existingList: { id: 42, listName: 'Klanten', lastFileName: 'klanten.xlsx' } } });
    const { user } = mount({}, authFetch);
    await user.click(await screen.findByRole('button', { name: /^Upload a list/ }));
    await user.click(screen.getByText('Next ▸'));
    await user.upload(await screen.findByLabelText('List file'), csvFile());
    await user.click(screen.getByRole('button', { name: 'Read the file ▸' }));
    expect(await screen.findByText(/A list called “Klanten” was uploaded before \(klanten\.xlsx\)/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Update that list' }));
    // An existing list keeps its name.
    expect(screen.getByRole('textbox', { name: 'List name' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Preview ▸' }));
    await screen.findByTestId('upload-counts');
    expect(bodyOf(authFetch, 'uploads/preview').listId).toBe(42);
    // Updating a list offers to remove what the file no longer has.
    await user.click(screen.getByRole('checkbox', { name: /Remove units no longer in the file/ }));
    await user.click(screen.getByRole('button', { name: 'Update the list' }));
    await waitFor(() => expect(bodyOf(authFetch, 'uploads/apply')).toMatchObject({ listId: 42, removeMissing: true }));
  });
});

describe('Re-import from the tree', () => {
  it('opens on the file step with the list chosen and fixed, without a way back to the source cards', async () => {
    const { user, authFetch } = mount({ reimportListId: 42 });
    expect(await screen.findByLabelText('List file')).toBeInTheDocument();
    const picker = screen.getByRole('combobox', { name: 'Update an existing list' });
    await waitFor(() => expect(picker).toHaveValue('42'));
    expect(picker).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    await user.upload(screen.getByLabelText('List file'), csvFile());
    await user.click(screen.getByRole('button', { name: 'Read the file ▸' }));
    await screen.findByRole('combobox', { name: 'Name' });
    const fd = authFetch.mock.calls.find(([u]) => String(u).includes('uploads/analyze'))[1].body;
    expect(fd.get('listId')).toBe('42');
  });
});
