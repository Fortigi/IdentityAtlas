// @vitest-environment jsdom
//
// The "save as view" wizard: it walks a report's parameters in the steps the
// report declares, will not move past a required one left empty, and saves the
// values it was given — what the person set up on the tab — under a name.

import { describe, it, expect, vi } from 'vitest';
import {
  renderWithProviders, makeAuthFetch, jsonResponse, screen, fireEvent, waitFor,
} from '@ui/test-utils/renderWithProviders';
import ReportViewWizard from '@ui/components/reports/ReportViewWizard';

const SCHEMA = {
  type: 'object',
  required: ['contexts'],
  properties: {
    contexts: { type: 'array', title: 'Contexts', 'x-step': 'Scope' },
    days: { type: 'integer', title: 'Days', 'x-step': 'Columns' },
  },
};
const REPORT = { name: 'access-review', displayName: 'Entitlement Pivot', parametersSchema: SCHEMA };
const VIEW = { ...REPORT, name: 'view-v1', displayName: 'Ledger review', view: { id: 'v1', reportName: 'access-review' } };
const SAVED = { id: 'v2', report: 'view-v2', name: 'Ledger review' };

function mount({ report = REPORT, initialParams = { contexts: 'c1', days: 30 }, answer = SAVED, stored } = {}) {
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  const authFetch = makeAuthFetch((url, init) => {
    if (init?.method === 'POST' || init?.method === 'PUT') return typeof answer === 'function' ? answer() : answer;
    if (String(url).startsWith('/api/report-views/')) return stored;
    return undefined;
  });
  renderWithProviders(
    <ReportViewWizard report={report} initialParams={initialParams} onSaved={onSaved} onCancel={onCancel} />,
    { auth: { authFetch } },
  );
  return { authFetch, onSaved, onCancel };
}

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next' }));
const sent = (authFetch) => {
  const [url, init] = authFetch.mock.calls.find(([, i]) => i?.method === 'POST' || i?.method === 'PUT');
  return { url, method: init.method, body: JSON.parse(init.body) };
};

describe('ReportViewWizard', () => {
  it('walks the report\'s own steps, then asks for a name, and saves what was set up', async () => {
    const { authFetch, onSaved } = mount();
    expect(screen.getByRole('heading', { name: 'Save "Entitlement Pivot" as a view' })).toBeInTheDocument();
    // Step 1 shows only the Scope parameters.
    expect(screen.getByLabelText('Contexts')).toBeInTheDocument();
    expect(screen.queryByLabelText('Days')).not.toBeInTheDocument();

    next();
    expect(screen.getByLabelText('Days')).toHaveValue(30);
    next();
    const save = screen.getByRole('button', { name: 'Save view' });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Ledger review ' } });
    fireEvent.change(screen.getByLabelText('Description (optional)'), { target: { value: 'For the owner' } });
    fireEvent.click(save);

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(SAVED, { created: true }));
    expect(sent(authFetch)).toEqual({
      url: '/api/report-views', method: 'POST',
      body: { name: 'Ledger review', description: 'For the owner', params: { contexts: 'c1', days: 30 }, reportName: 'access-review' },
    });
  });

  it('will not move past a required parameter left empty, and says which', () => {
    mount({ initialParams: {} });
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Fill in Contexts to continue.');
  });

  it('goes back a step, and cancels', () => {
    const { onCancel } = mount();
    next();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Contexts')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('says so when the name is taken, and keeps the wizard open', async () => {
    const { onSaved } = mount({ answer: () => jsonResponse({ error: 'A view with that name already exists' }, { ok: false, status: 409 }) });
    next(); next();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ledger review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    expect(await screen.findByText('There is already a view called "Ledger review". Pick another name.')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('shows the API\'s own reason for any other refusal', async () => {
    mount({ answer: () => jsonResponse({ error: 'A view needs a standard report that takes parameters' }, { ok: false, status: 400 }) });
    next(); next();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    expect(await screen.findByText('A view needs a standard report that takes parameters')).toBeInTheDocument();
  });

  it('edits a view from what is stored, and can save it as a new one instead', async () => {
    const { authFetch, onSaved } = mount({
      report: VIEW, stored: { id: 'v1', name: 'Ledger review', description: 'Stored description' },
    });
    expect(screen.getByRole('heading', { name: 'Edit view "Ledger review"' })).toBeInTheDocument();
    // Editing may jump straight to any step.
    fireEvent.click(screen.getByRole('button', { name: /Go to step 3: Name/ }));
    await waitFor(() => expect(screen.getByLabelText('Description (optional)')).toHaveValue('Stored description'));
    expect(screen.getByLabelText('Name')).toHaveValue('Ledger review');

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(SAVED, { created: false }));
    expect(sent(authFetch)).toMatchObject({ url: '/api/report-views/v1', method: 'PUT' });

    authFetch.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Save as a new view' }));
    await waitFor(() => expect(onSaved).toHaveBeenLastCalledWith(SAVED, { created: true }));
    expect(sent(authFetch)).toMatchObject({ url: '/api/report-views', method: 'POST', body: { reportName: 'access-review' } });
  });
});
