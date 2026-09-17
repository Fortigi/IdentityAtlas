// @vitest-environment jsdom
//
// Sign-in activity on the user detail page. The point of the section is that a
// timestamp never appears without the date it was measured on, so the fixtures
// use a measurement date far from every sign-in date — a component that showed
// the wrong one of the two would render a different string.

import { describe, it, expect, vi } from 'vitest';
import {
  renderWithProviders, makeAuthFetch, jsonResponse, screen, fireEvent, waitFor, within,
} from '@ui/test-utils/renderWithProviders';
import UserActivitySection from '@ui/components/UserActivitySection';
import { formatDate, formatDateOnly } from '@ui/utils/formatters';

const MEASURED = '2026-09-01T06:00:00.000Z';
const INTERACTIVE = '2026-03-14T09:26:00.000Z';
const NON_INTERACTIVE = '2026-04-20T11:00:00.000Z';
const SUCCESSFUL = '2026-05-05T12:30:00.000Z';
const FAILED = '2026-06-06T13:45:00.000Z';

function renderSection(body, props = {}) {
  const authFetch = makeAuthFetch((url) => (typeof body === 'function' ? body(url) : body));
  const utils = renderWithProviders(
    <UserActivitySection userId="user 1/a" authFetch={authFetch} {...props} />,
  );
  return { ...utils, authFetch };
}

// Each ActivityRow is a flex div of [label span, value span].
function rowFor(label) {
  const labelEl = screen.getByText(label);
  return labelEl.parentElement;
}

function valueOf(label) {
  // The value span holds the value text followed by the "measured on" span.
  const valueSpan = rowFor(label).children[1];
  const measured = valueSpan.querySelector('span');
  return {
    value: measured ? valueSpan.textContent.slice(0, -measured.textContent.length) : valueSpan.textContent,
    measured: measured ? measured.textContent : null,
  };
}

describe('UserActivitySection — loading and empty states', () => {
  it('fetches the activity for the URL-encoded user id', async () => {
    const { authFetch } = renderSection({ aggregates: [], perApp: [] });
    await screen.findByText('No activity recorded.');
    expect(authFetch).toHaveBeenCalledWith('/api/user/user%201%2Fa/activity');
  });

  it('renders nothing until the response arrives', () => {
    const authFetch = vi.fn(() => new Promise(() => {}));
    const { container } = renderWithProviders(<UserActivitySection userId="u1" authFetch={authFetch} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says "No activity recorded." when both lists are empty', async () => {
    renderSection({ aggregates: [], perApp: [] });
    expect(await screen.findByText('No activity recorded.')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
  });

  it('treats a body missing both lists as empty', async () => {
    renderSection({});
    expect(await screen.findByText('No activity recorded.')).toBeInTheDocument();
  });

  it('shows the empty state when the API answers with an error status', async () => {
    renderSection(jsonResponse({ error: 'boom' }, { ok: false, status: 500 }));
    expect(await screen.findByText('No activity recorded.')).toBeInTheDocument();
  });

  it('shows the empty state when the API answers 200 with a null body', async () => {
    renderSection(jsonResponse(null));
    expect(await screen.findByText('No activity recorded.')).toBeInTheDocument();
  });

  it('shows the empty state when the request itself fails', async () => {
    renderSection(() => { throw new Error('network down'); });
    expect(await screen.findByText('No activity recorded.')).toBeInTheDocument();
  });

  // React no longer warns on a set-state after unmount, so this can only show the
  // late response is swallowed without throwing — it exercises the cancel guard
  // on both the success and failure path rather than proving the guard exists.
  it('swallows a response or failure that arrives after unmount', async () => {
    let resolveOk; let rejectFail;
    const json = vi.fn(async () => ({ aggregates: [], perApp: [] }));
    const okFetch = vi.fn(() => new Promise((r) => { resolveOk = r; }));
    const failFetch = vi.fn(() => new Promise((_, rej) => { rejectFail = rej; }));
    const a = renderWithProviders(<UserActivitySection userId="u1" authFetch={okFetch} />);
    const b = renderWithProviders(<UserActivitySection userId="u2" authFetch={failFetch} />);
    a.unmount(); b.unmount();
    resolveOk({ ok: true, json });
    rejectFail(new Error('late'));
    await waitFor(() => expect(json).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('No activity recorded.')).toBeNull();
  });
});

describe('UserActivitySection — aggregate block', () => {
  it('shows each core timestamp under its own label, with the measurement date', async () => {
    renderSection({
      aggregates: [{
        activityType: 'aggregate',
        lastSignInDateTime: INTERACTIVE,
        lastNonInteractiveSignInDateTime: NON_INTERACTIVE,
        lastSuccessfulSignInDateTime: SUCCESSFUL,
        lastFailedSignInDateTime: FAILED,
        measuredAt: MEASURED,
      }],
      perApp: [],
    });
    await screen.findByText('Last interactive sign-in');
    const measured = `measured on ${formatDateOnly(MEASURED)}`;
    expect(valueOf('Last interactive sign-in')).toEqual({ value: formatDate(INTERACTIVE), measured });
    expect(valueOf('Last non-interactive sign-in')).toEqual({ value: formatDate(NON_INTERACTIVE), measured });
    expect(valueOf('Last successful sign-in')).toEqual({ value: formatDate(SUCCESSFUL), measured });
    expect(valueOf('Last failed sign-in')).toEqual({ value: formatDate(FAILED), measured });
  });

  it('lists the core timestamps in auditor order and omits the ones not present', async () => {
    const { container } = renderSection({
      aggregates: [{ activityType: 'aggregate', lastFailedSignInDateTime: FAILED, lastSignInDateTime: INTERACTIVE, measuredAt: MEASURED }],
      perApp: [],
    });
    await screen.findByText('Last interactive sign-in');
    const labels = [...container.querySelectorAll('.flex-wrap > span:first-child')].map((s) => s.textContent);
    expect(labels).toEqual(['Last interactive sign-in', 'Last failed sign-in']);
    expect(screen.queryByText('Last successful sign-in')).toBeNull();
    expect(screen.queryByText('None recorded')).toBeNull();
  });

  it('omits "measured on" when the row carries no measurement date', async () => {
    renderSection({ aggregates: [{ activityType: 'aggregate', lastSignInDateTime: INTERACTIVE }], perApp: [] });
    await screen.findByText('Last interactive sign-in');
    expect(valueOf('Last interactive sign-in')).toEqual({ value: formatDate(INTERACTIVE), measured: null });
    expect(screen.queryByText(/measured on/)).toBeNull();
  });

  it('renders service-principal extendedAttributes: dates formatted, other values verbatim', async () => {
    renderSection({
      aggregates: [{
        activityType: 'servicePrincipal',
        measuredAt: MEASURED,
        extendedAttributes: {
          applicationAuthenticationClientSignInActivity: SUCCESSFUL,
          delegatedClientStatus: 'enabled',
          // Date.parse accepts all three; none is a date.
          numericText: '3',
          labelWithNumber: 'Enabled 1',
          notARealDay: '2026-13-45',
          failureCount: 7,
          isDisabled: false,
          details: { tenant: 'contoso' },
          emptyValue: '',
          nullValue: null,
        },
      }],
      perApp: [],
    });
    await screen.findByText('Application Authentication Client Sign In Activity');
    const measured = `measured on ${formatDateOnly(MEASURED)}`;
    expect(valueOf('Application Authentication Client Sign In Activity'))
      .toEqual({ value: formatDate(SUCCESSFUL), measured });
    expect(valueOf('Delegated Client Status').value).toBe('enabled');
    expect(valueOf('Numeric Text').value).toBe('3');
    expect(valueOf('Label With Number').value).toBe('Enabled 1');
    expect(valueOf('Not A Real Day').value).toBe('2026-13-45');
    expect(valueOf('Failure Count').value).toBe('7');
    expect(valueOf('Is Disabled').value).toBe('false');
    expect(valueOf('Details').value).toBe('{"tenant":"contoso"}');
    expect(valueOf('Empty Value').value).toBe('—');
    expect(valueOf('Null Value').value).toBe('—');
    expect(screen.queryByText('None recorded')).toBeNull();
  });

  it('ignores extendedAttributes that are not an object', async () => {
    renderSection({
      aggregates: [{ activityType: 'aggregate', extendedAttributes: 'not-json', measuredAt: MEASURED }],
      perApp: [],
    });
    // A string would otherwise be spread into one row per character.
    expect(await screen.findByText('None recorded')).toBeInTheDocument();
    expect(valueOf('Sign-in timestamps').measured).toBe(`measured on ${formatDateOnly(MEASURED)}`);
  });

  it('shows a sign-in count, including a count of zero', async () => {
    renderSection({
      aggregates: [
        { activityType: 'a', signInCount: 0, measuredAt: MEASURED },
        { activityType: 'b', signInCount: 12 },
      ],
      perApp: [],
    });
    await screen.findAllByText('Sign-ins counted');
    const rows = screen.getAllByText('Sign-ins counted').map((l) => l.parentElement.children[1]);
    expect(rows[0].firstChild.textContent).toBe('0');
    expect(rows[1].textContent).toBe('12');
    // A zero count is data, so the "nothing recorded" placeholder must not appear.
    expect(screen.queryByText('None recorded')).toBeNull();
  });

  it('says "None recorded" for an aggregate row with no timestamps, attributes or count', async () => {
    renderSection({
      aggregates: [{ activityType: 'aggregate', extendedAttributes: {}, signInCount: null, measuredAt: MEASURED }],
      perApp: [],
    });
    expect(await screen.findByText('None recorded')).toBeInTheDocument();
    expect(screen.queryByText('No activity recorded.')).toBeNull();
  });

  it('draws one block per activity type', async () => {
    const { container } = renderSection({
      aggregates: [
        { activityType: 'interactive', lastSignInDateTime: INTERACTIVE },
        { activityType: 'servicePrincipal', lastFailedSignInDateTime: FAILED },
      ],
      perApp: [],
    });
    await screen.findByText('Last interactive sign-in');
    expect(container.querySelectorAll('.divide-y')).toHaveLength(2);
    expect(screen.getByText('Last failed sign-in')).toBeInTheDocument();
    expect(screen.queryByText('Last used per application')).toBeNull();
  });
});

describe('UserActivitySection — per-application table', () => {
  const PER_APP = [
    { resourceId: 'sp-1', appDisplayName: 'Salesforce', lastSignInDateTime: INTERACTIVE, lastSuccessfulSignInDateTime: SUCCESSFUL, measuredAt: MEASURED },
    { resourceId: 'sp-2', appDisplayName: null, lastSuccessfulSignInDateTime: SUCCESSFUL, measuredAt: NON_INTERACTIVE },
    { resourceId: 'sp-3', appDisplayName: 'Never used', measuredAt: MEASURED },
  ];

  function cells() {
    const table = screen.getByRole('table');
    return within(table).getAllByRole('row').slice(1)
      .map((tr) => within(tr).getAllByRole('cell').map((td) => td.textContent));
  }

  it('renders the table without aggregates and falls back per column', async () => {
    renderSection({ perApp: PER_APP });
    await screen.findByText('Last used per application');
    expect(cells()).toEqual([
      // Interactive sign-in wins over the successful one when both exist.
      ['Salesforce', formatDate(INTERACTIVE), formatDateOnly(MEASURED)],
      // No display name → the id; no interactive time → the successful one.
      ['sp-2', formatDate(SUCCESSFUL), formatDateOnly(NON_INTERACTIVE)],
      // Neither timestamp → a dash, not a blank cell.
      ['Never used', '—', formatDateOnly(MEASURED)],
    ]);
  });

  it('shows plain text, not buttons, when there is no detail handler', async () => {
    renderSection({ aggregates: [], perApp: PER_APP });
    await screen.findByText('Salesforce');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('opens the application detail with its id and display name (or id) when clicked', async () => {
    const onOpenDetail = vi.fn();
    renderSection({ aggregates: [], perApp: PER_APP }, { onOpenDetail });
    fireEvent.click(await screen.findByRole('button', { name: 'Salesforce' }));
    expect(onOpenDetail).toHaveBeenLastCalledWith('user', 'sp-1', 'Salesforce');
    fireEvent.click(screen.getByRole('button', { name: 'sp-2' }));
    expect(onOpenDetail).toHaveBeenLastCalledWith('user', 'sp-2', 'sp-2');
    expect(onOpenDetail).toHaveBeenCalledTimes(2);
  });
});
