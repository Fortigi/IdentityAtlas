// @vitest-environment jsdom
//
// The confidence-driven review of one transcript against stubbed routes:
// statements grouped by band (order, counts), bulk Accept/Reject per group and
// for everything shown (exact ids, only the proposed ones, only after the
// confirm, nothing on cancel), the confidence / corroboration pills and parts,
// "Score again", renaming a mention from a statement and from the Mentions
// tab, and the Source tab's full text and original-file download.
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, makeAuthFetch, jsonResponse, blobResponse, screen, userEvent, waitFor, within } from '@ui/test-utils/renderWithProviders';
import { pillColorClass } from '@ui/components/orgtruth/orgFormat';
import TranscriptDetail from './TranscriptDetail';

vi.mock('@ui/utils/download', async (orig) => ({ ...(await orig()), triggerDownload: vi.fn() }));
const { triggerDownload } = await import('@ui/utils/download');

const WRITER = { hasWildcard: false, permissions: new Set(['data.read', 'data.write.contexts']) };
const K = '/api/org-truth/knowledge';
const TEXT = 'Anna: we moved to FortiG last year.\n\n  Bob:   indented line kept.';
const SOURCE = { id: 's1', displayName: 'Intake Anna', observedAt: '2026-10-01T00:00:00Z', metadata: {}, textContent: TEXT, passages: [{ id: 'p1', seq: 1, startChar: 0, endChar: 35, text: 'Anna: we moved to FortiG last year.' }], runs: [] };

const side = (mentionId, label, type, originalLabel) => ({ mentionId, label, type, ...(originalLabel !== undefined ? { originalLabel } : {}) });
const claim = (id, over) => ({ id, predicate: 'memberOf', qualifier: null, modality: 'stated', support: 'supported', status: 'proposed', topic: 'membership', evidence: [], subject: side('m1', 'Anna', 'person', 'Ana'), object: side(`o-${id}`, `Team ${id}`, 'team'), ...over });
const H1 = claim('h1', { confidence: 92, band: 'high', topic: 'customers', corroboration: { verdict: 'corroborated', kind: 'context', detail: 'member of the group "IT-Commissie"' }, confidenceParts: { transcript: 60, matching: 10, data: 22 } });
const H2 = claim('h2', { confidence: 80, subject: side('m9', 'Bob', 'person', 'Bob') });
const H3 = claim('h3', { confidence: 88, band: 'high', status: 'accepted' });
const M1 = claim('m1c', { confidence: 55, band: 'medium', corroboration: { verdict: 'contradicted', kind: 'directory', detail: 'not in the staff list' } });
const L1 = claim('l1c', { confidence: 30, band: 'low' });
const CLAIMS = [L1, H1, M1, H2, H3];
const MENTIONS = [{ id: 'mx', type: 'organisation', label: 'Fortigi', originalLabel: 'FortiG', renamedBy: 'wim', resolution: 'unmatched', occurrences: [], candidates: [] }];

function render({ canEdit = true, claims = () => CLAIMS, rescore = () => ({ scored: 5, corroborated: 1, contradicted: 1 }), original } = {}) {
  const authFetch = makeAuthFetch((url, opts) => {
    if (url === `${K}/sources/s1`) return SOURCE;
    if (url === `${K}/sources/s1/claims/bulk`) return { status: JSON.parse(opts.body).status, updated: 2, ids: [] };
    if (url.startsWith(`${K}/sources/s1/claims`)) return claims(url);
    if (url === `${K}/sources/s1/rescore`) return rescore();
    if (url === `${K}/sources/s1/mentions`) return MENTIONS;
    if (url === `${K}/sources/s1/original`) return original ?? blobResponse('raw', { type: 'text/plain', filename: 'intake-anna.vtt' });
    if (url.startsWith(`${K}/mentions/`)) return { mention: { id: 'm1' }, candidates: [], confidence: 0 };
    return undefined;
  });
  renderWithProviders(<TranscriptDetail sourceId="s1" canEdit={canEdit} onBack={() => {}} onOpenDetail={() => {}} />,
    { auth: { authFetch, ...WRITER }, features: { orgTruth: true, knowledgeExtraction: true } });
  return { authFetch };
}

const calls = (af, url, method) => af.mock.calls.filter(([u, o]) => u === url && (!method || o?.method === method));
const loads = (af) => af.mock.calls.filter(([u, o]) => u.startsWith(`${K}/sources/s1/claims?`) && !o?.method).length;
const body = (call) => JSON.parse(call[1].body);
const BULK = `${K}/sources/s1/claims/bulk`;
const region = (name) => screen.findByRole('region', { name });
const row = (id) => screen.findByRole('listitem', { name: new RegExp(`Team ${id}$`) });

describe('Statements grouped by confidence', () => {
  it('groups High, Medium, Low in that order with their counts, whatever the API order', async () => {
    render();
    await region('High confidence');
    const names = screen.getAllByRole('region').map(r => r.getAttribute('aria-label'));
    expect(names).toEqual(['High confidence', 'Medium confidence', 'Low confidence']);
    expect(screen.getByRole('heading', { name: /High confidence \(3\)/ })).toHaveTextContent('≥ 80');
    expect(screen.getByRole('heading', { name: /Medium confidence \(1\)/ })).toBeInTheDocument();
    const high = within(await region('High confidence'));
    expect(high.getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['Anna member of Team h1', 'Bob member of Team h2', 'Anna member of Team h3']);
  });

  it('groups by topic on request', async () => {
    render();
    await region('High confidence');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Group by' }), 'Topic');
    expect(screen.getAllByRole('region').map(r => r.getAttribute('aria-label'))).toEqual(['Topic membership', 'Topic customers']);
  });

  it('accepts a group: only its proposed ids, only after the confirm, then reloads', async () => {
    const { authFetch } = render();
    const high = within(await region('High confidence'));
    expect(high.queryByRole('button', { name: 'Accept all 3' })).toBeNull();
    await userEvent.click(high.getByRole('button', { name: 'Accept all 2' }));
    expect(await screen.findByText('Accept the 2 statements in High confidence? Statements already decided are not changed.')).toBeInTheDocument();
    expect(calls(authFetch, BULK)).toHaveLength(0);
    const before = loads(authFetch);
    await userEvent.click(screen.getByRole('button', { name: 'Accept 2' }));
    await waitFor(() => expect(calls(authFetch, BULK, 'PUT')).toHaveLength(1));
    expect(body(calls(authFetch, BULK, 'PUT')[0])).toEqual({ status: 'accepted', ids: ['h1', 'h2'] });
    await waitFor(() => expect(loads(authFetch)).toBe(before + 1));
  });

  it('sends nothing when the reviewer cancels', async () => {
    const { authFetch } = render();
    const low = within(await region('Low confidence'));
    await userEvent.click(low.getByRole('button', { name: 'Reject all 1' }));
    expect(await screen.findByText('Reject the 1 statement in Low confidence?', { exact: false })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Please confirm')).toBeNull());
    expect(calls(authFetch, BULK)).toHaveLength(0);
  });

  it('rejects everything shown with every proposed id of the list', async () => {
    const { authFetch } = render();
    await region('High confidence');
    await userEvent.click(screen.getByRole('button', { name: 'Reject all shown' }));
    expect(await screen.findByText('Reject the 4 shown statements? Statements already decided are not changed.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reject 4' }));
    await waitFor(() => expect(calls(authFetch, BULK, 'PUT')).toHaveLength(1));
    expect(body(calls(authFetch, BULK, 'PUT')[0])).toEqual({ status: 'rejected', ids: ['l1c', 'h1', 'm1c', 'h2'] });
  });

  it('offers no bulk buttons outside the proposed filter, nor any edit action to a reader', async () => {
    render();
    await region('High confidence');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Accepted');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Accept all shown' })).toBeNull());
    expect(screen.queryByRole('button', { name: /^Accept all \d/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Score again' })).toBeInTheDocument();
  });

  it('is read-only for a reader', async () => {
    render({ canEdit: false });
    await region('High confidence');
    expect(screen.queryByRole('button', { name: 'Accept all shown' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accept all 2' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Score again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename Anna' })).toBeNull();
  });

  it('scores again, says what it found and reloads', async () => {
    const { authFetch } = render();
    await region('High confidence');
    const before = loads(authFetch);
    await userEvent.click(screen.getByRole('button', { name: 'Score again' }));
    const post = calls(authFetch, `${K}/sources/s1/rescore`, 'POST');
    expect(post).toHaveLength(1);
    expect(body(post[0])).toEqual({});
    expect(await screen.findByText('Scored 5 statements: 1 confirmed by data, 1 contradicted.')).toBeInTheDocument();
    await waitFor(() => expect(loads(authFetch)).toBe(before + 1));
  });

  it('says so when the rescore is refused', async () => {
    render({ rescore: () => jsonResponse({ error: 'No local model.' }, { ok: false, status: 409 }) });
    await region('High confidence');
    await userEvent.click(screen.getByRole('button', { name: 'Score again' }));
    expect(await screen.findByText('Not scored: No local model.')).toBeInTheDocument();
  });
});

describe('Statement score and rename', () => {
  it('shows the confidence in its band colour, the corroboration with its detail, and the parts', async () => {
    render();
    const h1 = within(await row('h1'));
    expect(h1.getByText('92%').className).toContain(pillColorClass('green'));
    const confirmed = h1.getByText('confirmed by data');
    expect(confirmed.className).toContain(pillColorClass('green'));
    expect(confirmed).toHaveAttribute('title', 'member of the group "IT-Commissie"');
    expect(h1.getByText('member of the group "IT-Commissie"')).toBeInTheDocument();
    expect(h1.getByText('transcript 60 · matching 10 · data 22')).toBeInTheDocument();
    const m1 = within(await row('m1c'));
    expect(m1.getByText('55%').className).toContain(pillColorClass('amber'));
    const contradicted = m1.getByText('contradicted by data');
    expect(contradicted.className).toContain(pillColorClass('red'));
    expect(contradicted).toHaveAttribute('title', 'not in the staff list');
    expect(within(await row('l1c')).getByText('30%').className).toContain(pillColorClass('red'));
    expect(within(await row('l1c')).queryByText(/by data/)).toBeNull();
  });

  it('shows the transcript spelling only when the name was changed', async () => {
    render();
    expect(within(await row('h1')).getByText('(transcript: Ana)')).toBeInTheDocument();
    expect(within(await row('h2')).queryByText(/transcript:/)).toBeNull();
  });

  it('renames and retypes a mention from a statement, then reloads the statements', async () => {
    const { authFetch } = render();
    const h1 = within(await row('h1'));
    await userEvent.click(h1.getByRole('button', { name: 'Rename Anna' }));
    const name = h1.getByRole('textbox', { name: 'Name' });
    expect(name).toHaveValue('Anna');
    expect(h1.getByRole('combobox', { name: 'Type' })).toHaveValue('person');
    await userEvent.clear(name);
    await userEvent.type(name, ' Anna de Vries ');
    await userEvent.selectOptions(h1.getByRole('combobox', { name: 'Type' }), 'role');
    const before = loads(authFetch);
    await userEvent.click(h1.getByRole('button', { name: 'Save' }));
    const puts = calls(authFetch, `${K}/mentions/m1`, 'PUT');
    expect(puts).toHaveLength(1);
    expect(body(puts[0])).toEqual({ label: 'Anna de Vries', type: 'role' });
    await waitFor(() => expect(loads(authFetch)).toBe(before + 1));
  });

  it('does not save an empty name', async () => {
    render();
    const h1 = within(await row('h1'));
    await userEvent.click(h1.getByRole('button', { name: 'Rename Team h1' }));
    await userEvent.clear(h1.getByRole('textbox', { name: 'Name' }));
    expect(h1.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.click(h1.getByRole('button', { name: 'Cancel' }));
    expect(h1.getByRole('button', { name: 'Rename Team h1' })).toBeInTheDocument();
  });

  it('renames from the Mentions tab and shows what the transcript said', async () => {
    const { authFetch } = render();
    await screen.findByRole('heading', { name: 'Intake Anna' });
    await userEvent.click(screen.getByRole('tab', { name: 'Mentions' }));
    const card = within(await region('Mention Fortigi'));
    expect(card.getByText('transcript said: FortiG')).toBeInTheDocument();
    await userEvent.click(card.getByRole('button', { name: 'Rename Fortigi' }));
    await userEvent.selectOptions(card.getByRole('combobox', { name: 'Type' }), 'customer');
    await userEvent.click(card.getByRole('button', { name: 'Save' }));
    const puts = calls(authFetch, `${K}/mentions/mx`, 'PUT');
    expect(puts).toHaveLength(1);
    expect(body(puts[0])).toEqual({ label: 'Fortigi', type: 'customer' });
  });
});

describe('Source: full text and original file', () => {
  const openSource = async () => {
    await screen.findByRole('heading', { name: 'Intake Anna' });
    await userEvent.click(screen.getByRole('tab', { name: 'Source' }));
  };

  it('shows the passages first and the stored text verbatim on "Full text"', async () => {
    render();
    await openSource();
    expect(await screen.findByRole('list', { name: 'Passages' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Passages' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Full text' }));
    const pre = screen.getByLabelText('Full text', { selector: 'pre' });
    expect(pre.textContent).toBe(TEXT);
    expect(screen.queryByRole('list', { name: 'Passages' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Full text' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('downloads the original file under the server\'s name', async () => {
    const { authFetch } = render();
    await openSource();
    await userEvent.click(await screen.findByRole('button', { name: 'Download original file' }));
    await waitFor(() => expect(triggerDownload).toHaveBeenCalledWith('intake-anna.vtt', expect.any(Blob)));
    expect(calls(authFetch, `${K}/sources/s1/original`)).toHaveLength(1);
  });

  it('says so when the download fails', async () => {
    render({ original: jsonResponse({}, { ok: false, status: 404 }) });
    await openSource();
    await userEvent.click(await screen.findByRole('button', { name: 'Download original file' }));
    expect(await screen.findByText('The download failed: HTTP 404')).toBeInTheDocument();
  });
});
