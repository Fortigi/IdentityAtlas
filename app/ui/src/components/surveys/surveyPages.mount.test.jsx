// @vitest-environment jsdom
// The surveys around the form: the person's list, the Surveys page with its
// Templates tab, the template editor, and the respondent-only shell.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, userEvent, within } from '@ui/test-utils/renderWithProviders';
import MySurveys from './MySurveys';
import SurveyTemplates from './SurveyTemplates';
import TemplateEditor from './TemplateEditor';
import SurveysPage from '@ui/components/SurveysPage';
import SurveyRespondentPage from '@ui/components/SurveyRespondentPage';

const REQ = 'ffffffff-0000-4000-8000-000000000001';
const TPL = 'eeeeeeee-0000-4000-8000-000000000001';
const definition = { schemaVersion: 1, languages: ['en'], title: 'Check {context}', sections: [{ id: 's', questions: [{ id: 'q', text: 'Still used?', answer: { type: 'yesNo' } }] }] };
const mine = (data) => ({ me: { principalId: 'p', displayName: 'Anna' }, data });
const survey = (over = {}) => ({ id: REQ, templateName: 'Intake', contextName: 'Payroll', status: 'sent', sentAt: '2026-10-20T10:00:00Z', dueAt: '2020-01-01', ...over });

beforeEach(() => { window.location.hash = ''; });

describe('MySurveys', () => {
  it('lists the surveys, marks an overdue one, and opens one', async () => {
    const onOpen = vi.fn();
    renderWithProviders(<MySurveys onOpen={onOpen} />, { auth: { authFetch: makeAuthFetch({ '/api/surveys/mine': mine([survey(), survey({ id: 'x', status: 'submitted', dueAt: null })]) }) } });
    const open = await screen.findByRole('button', { name: /Intake: Payroll.*overdue.*To answer/ });
    expect(screen.getByRole('button', { name: /Answered/ })).not.toHaveTextContent('overdue');
    await userEvent.setup().click(open);
    expect(onOpen).toHaveBeenCalledWith(REQ);
  });

  it('says why there is nothing: no account mapped, or none sent; and an error', async () => {
    const { unmount } = renderWithProviders(<MySurveys onOpen={vi.fn()} />, { auth: { authFetch: makeAuthFetch({ '/api/surveys/mine': { me: null, data: [] } }) } });
    expect(await screen.findByTestId('no-me')).toBeInTheDocument();
    unmount();
    const r = renderWithProviders(<MySurveys onOpen={vi.fn()} />, { auth: { authFetch: makeAuthFetch({ '/api/surveys/mine': mine([]) }) } });
    expect(await screen.findByText('No surveys have been sent to you.')).toBeInTheDocument();
    r.unmount();
    renderWithProviders(<MySurveys onOpen={vi.fn()} />, { auth: { authFetch: makeAuthFetch({}) } });
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
  });
});

describe('SurveysPage', () => {
  it('an analyst gets the Templates tab; a survey link opens the form, and back returns to the list', async () => {
    const authFetch = makeAuthFetch({
      '/api/surveys/mine': mine([survey()]),
      '/api/surveys/templates?includeArchived=true': { data: [{ id: TPL, name: 'Intake', contextCategory: 'LogicalApplication', currentVersion: 2, requestCount: 3, builtIn: true }] },
      [`/api/surveys/requests/${REQ}`]: { id: REQ, definition, rows: {}, answers: {}, status: 'sent', asRecipient: true, contextName: 'Payroll', recipientName: 'Anna' },
    });
    renderWithProviders(<SurveysPage />, { auth: { authFetch } });
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Templates' }));
    expect(await screen.findByRole('button', { name: 'Intake' })).toBeInTheDocument();
    expect(screen.getByText('built in')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'For you' }));
    await user.click(await screen.findByRole('button', { name: /Intake: Payroll/ }));
    expect(window.location.hash).toBe(`#surveys?request=${REQ}`);
    expect(await screen.findByRole('heading', { name: 'Check Payroll' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '← All surveys' }));
    await waitFor(() => expect(window.location.hash).toBe('#surveys'));
  });

  it('someone without data.write.contexts sees only their own surveys', async () => {
    renderWithProviders(<SurveysPage />, { auth: { hasWildcard: false, permissions: new Set(), authFetch: makeAuthFetch({ '/api/surveys/mine': mine([]) }) } });
    expect(screen.queryByRole('tab', { name: 'Templates' })).not.toBeInTheDocument();
    expect(await screen.findByText('No surveys have been sent to you.')).toBeInTheDocument();
  });
});

describe('SurveyTemplates', () => {
  it('opens a template for editing, and archives one', async () => {
    const authFetch = makeAuthFetch((url, opts = {}) => {
      if (url === '/api/surveys/templates?includeArchived=true') return { data: [{ id: TPL, name: 'Intake', contextCategory: 'OrganizationalUnit', scopeRootName: 'Customers', currentVersion: 1 }] };
      if (url === `/api/surveys/templates/${TPL}` && opts.method === 'PUT') return { id: TPL };
      if (url === `/api/surveys/templates/${TPL}`) return { id: TPL, name: 'Intake', contextCategory: 'OrganizationalUnit', definition };
      if (url === '/api/surveys/templates/validate') return { errors: [] };
      return undefined;
    });
    renderWithProviders(<SurveyTemplates />, { auth: { authFetch } });
    const user = userEvent.setup();
    expect(await screen.findByText('Organisational unit under Customers')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(`/api/surveys/templates/${TPL}`, expect.objectContaining({ method: 'PUT', body: '{"archived":true}' })));
    await user.click(screen.getByRole('button', { name: 'Intake' }));
    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('Intake');
  });
});

describe('TemplateEditor', () => {
  it('shows what is wrong with the questions and saves only when they are right', async () => {
    const authFetch = makeAuthFetch((url, opts = {}) => {
      if (url === '/api/surveys/templates/validate') {
        const { definition: d } = JSON.parse(opts.body);
        return { errors: d.title ? [] : [{ path: 'title', message: 'is required' }] };
      }
      if (url === '/api/surveys/templates' && opts.method === 'POST') return jsonResponse({ id: TPL, name: 'Mine', currentVersion: 1 }, { status: 201 });
      return undefined;
    });
    const onSaved = vi.fn();
    renderWithProviders(<TemplateEditor template={null} onSaved={onSaved} onCancel={vi.fn()} />, { auth: { authFetch } });
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Mine');
    const json = screen.getByRole('textbox', { name: 'Questions (JSON)' });
    await user.clear(json);
    await user.click(json);
    await user.paste('{ "nope"');
    expect(await screen.findByRole('alert')).toHaveTextContent('Not valid JSON');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.clear(json);
    await user.paste(JSON.stringify({ ...definition, title: '' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('title: is required');
    await user.clear(json);
    await user.paste(JSON.stringify(definition));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(screen.getByText('Still used?')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Asked about' }), 'LogicalApplication');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: TPL })));
    const [, init] = authFetch.mock.calls.find(([u, o]) => u === '/api/surveys/templates' && o?.method === 'POST');
    expect(JSON.parse(init.body)).toEqual({ name: 'Mine', description: '', contextCategory: 'LogicalApplication', scopeRootContextId: null, definition });
  });

  it('an existing template saves with PUT and shows the API\'s refusal', async () => {
    const authFetch = makeAuthFetch((url, opts = {}) => {
      if (url === '/api/surveys/templates/validate') return { errors: [] };
      if (opts.method === 'PUT') return jsonResponse({ error: 'Choose another name' }, { ok: false, status: 409 });
      return undefined;
    });
    renderWithProviders(<TemplateEditor template={{ id: TPL, name: 'Old', contextCategory: 'OrganizationalUnit', scopeRootContextId: 'c1', scopeRootName: 'Customers', definition }} onSaved={vi.fn()} onCancel={vi.fn()} />, { auth: { authFetch } });
    expect(screen.getByTestId('tpl-scope')).toHaveTextContent('Customers');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'clear' }));
    expect(screen.getByTestId('tpl-scope')).toHaveTextContent('Anywhere');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Choose another name')).toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledWith(`/api/surveys/templates/${TPL}`, expect.objectContaining({ method: 'PUT' }));
  });
});

describe('SurveyRespondentPage', () => {
  it('shows only the person\'s surveys and signs out', async () => {
    const logout = vi.fn();
    renderWithProviders(<SurveyRespondentPage />, { auth: { logout, account: { name: 'Anna' }, authFetch: makeAuthFetch({ '/api/surveys/mine': mine([survey()]) }) } });
    expect(screen.getByRole('heading', { name: 'Your surveys' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Intake: Payroll/ })).toBeInTheDocument();
    expect(within(screen.getByRole('banner')).getByText('Anna')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    expect(logout).toHaveBeenCalled();
  });

  it('opens a survey from its link', async () => {
    window.location.hash = `#surveys?request=${REQ}`;
    renderWithProviders(<SurveyRespondentPage />, { auth: { authFetch: makeAuthFetch({ [`/api/surveys/requests/${REQ}`]: { id: REQ, definition, rows: {}, answers: {}, status: 'sent', asRecipient: true, contextName: 'Payroll', recipientName: 'Anna' } }) } });
    expect(await screen.findByRole('heading', { name: 'Check Payroll' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '← Your surveys' })).toBeInTheDocument();
  });
});
