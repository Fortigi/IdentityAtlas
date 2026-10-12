// @vitest-environment jsdom
//
// One transcript against stubbed routes: Extract (mode + 409 with setup text),
// polling the run until it completes (pct, done/total, stop), cancel, the
// statements review (expectedStatus, the 409 message + refetch, edit, the
// highlighted quote inside its passage, the status filter), the mentions review
// (confirm / reject / reset / choose another), findings, the source passages
// and the JSON export.
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, makeAuthFetch, jsonResponse, blobResponse, screen, userEvent, waitFor, within } from '@ui/test-utils/renderWithProviders';
import TranscriptDetail from './TranscriptDetail';

vi.mock('@ui/utils/download', async (orig) => ({ ...(await orig()), triggerDownload: vi.fn() }));
const { triggerDownload } = await import('@ui/utils/download');

const WRITER = { hasWildcard: false, permissions: new Set(['data.read', 'data.write.contexts']) };
const K = '/api/org-truth/knowledge';

const P1 = { id: 'p1', seq: 1, startChar: 0, endChar: 40, text: 'Anna leads the Harbour team since March.', speaker: 'Anna', startMs: 65000 };
const P2 = { id: 'p2', seq: 2, startChar: 41, endChar: 79, text: 'She also works for Contoso on billing.', speaker: null, startMs: null };
const SOURCE = {
  id: 's1', displayName: 'Intake Anna', observedAt: '2026-10-01T00:00:00Z',
  metadata: { speaker: 'Anna', language: 'nl', sourceType: 'interview', classification: 'internal', format: 'text' },
  passages: [P1, P2],
  runs: [{ id: 'r0', status: 'completed', details: { model: 'qwen3-4b', config: { mode: 'single' } }, stats: { written: { claims: 4, mentions: 3, findings: 1 } }, createdAt: '2026-10-01T10:00:00Z', finishedAt: '2026-10-01T10:05:00Z' }],
};

const CLAIM = {
  id: 'c1', predicate: 'worksForCustomer', qualifier: 'billing', modality: 'stated', topic: 'customers', support: 'supported',
  status: 'proposed', rejectedBy: null, edited: null, confidence: 80,
  subject: { mentionId: 'm1', label: 'Anna', type: 'person' }, object: { mentionId: 'm2', label: 'Contoso', type: 'customer' },
  evidence: [{ id: 'e1', seq: 2, startChar: 50, endChar: 67, quote: 'works for Contoso', support: 'supported' }],
};
const VERIFIER_REJECTED = { ...CLAIM, id: 'c2', predicate: 'leads', qualifier: null, topic: 'membership', status: 'rejected', rejectedBy: 'verifier', evidence: [] };

const CAND = (over) => ({ linkId: 'l1', targetType: 'Identity', targetId: 'i1', label: 'Anna de Vries', kind: null, confidence: 82, reasons: ['name'], matchedValue: 'Anna', status: 'proposed', ...over });
const MENTIONS = [
  { id: 'm1', type: 'person', label: 'Anna', resolution: 'candidates', occurrences: [{ seq: 1 }, { seq: 2 }], candidates: [CAND(), CAND({ linkId: 'l2', targetId: 'i2', label: 'Anna Smit', confidence: 40, status: 'rejected' })] },
  { id: 'm3', type: 'team', label: 'Harbour', resolution: 'unmatched', occurrences: [{ seq: 1 }], candidates: [] },
];
const FINDINGS = [
  { id: 'f1', kind: 'question', category: 'membership', text: 'Since when exactly does Anna lead Harbour?', origin: 'model', status: 'open', related: {} },
  { id: 'f2', kind: 'issue', category: 'conflict', text: 'Contradicts the staff list.', origin: 'rule', status: 'dismissed', related: {} },
];

function render({ claims = () => [CLAIM], extract, runPolls = [], cancel = { id: 'r1', cancelRequested: true }, claimPut = () => ({ id: 'c1' }), search = () => ({ candidates: [] }), source = SOURCE, exportAnswer } = {}) {
  let poll = 0;
  const exact = {
    [`${K}/sources/s1`]: () => source,
    [`${K}/sources/s1/mentions`]: () => MENTIONS,
    [`${K}/sources/s1/findings`]: () => FINDINGS,
    [`${K}/sources/s1/export`]: () => exportAnswer ?? blobResponse('{"a":1}', { type: 'application/json', filename: 'knowledge-s1.json' }),
    [`${K}/sources/s1/extract`]: () => extract(),
    [`${K}/runs/r1/cancel`]: () => cancel,
    [`${K}/runs/r1`]: () => runPolls[Math.min(poll++, runPolls.length - 1)],
  };
  const prefixed = [
    [`${K}/sources/s1/claims`, claims],
    [`${K}/claims/`, claimPut],
    [`${K}/matches/`, () => ({ link: {} })],
    [`${K}/findings/`, () => ({ id: 'f1' })],
    [`${K}/search`, search],
  ];
  const authFetch = makeAuthFetch((url) => {
    const answer = exact[url] ?? prefixed.find(([p]) => url.startsWith(p))?.[1];
    return answer?.(url);
  });
  const onOpenDetail = vi.fn();
  renderWithProviders(<TranscriptDetail sourceId="s1" canEdit onBack={() => {}} onOpenDetail={onOpenDetail} />,
    { auth: { authFetch, ...WRITER }, features: { orgTruth: true, knowledgeExtraction: true } });
  return { authFetch, onOpenDetail };
}

const calls = (af, prefix, method) => af.mock.calls.filter(([u, o]) => u.startsWith(prefix) && (!method || o?.method === method));
const body = (call) => JSON.parse(call[1].body);
// A decision disables the buttons until its PUT and refetch are done.
async function clickSettled(button) {
  await userEvent.click(button);
  await waitFor(() => expect(button).toBeEnabled());
}

describe('TranscriptDetail — header and run', () => {
  it('shows the metadata and the run history', async () => {
    render();
    expect(await screen.findByRole('heading', { name: 'Intake Anna' })).toBeInTheDocument();
    expect(screen.getByText(/speaker Anna · nl · interview · internal · text · 2 passages/)).toBeInTheDocument();
    const history = screen.getByRole('table', { name: 'Run history' });
    expect(history).toHaveTextContent('single');
    expect(history).toHaveTextContent('qwen3-4b');
    expect(history).toHaveTextContent('4 statements · 3 mentions · 1 findings');
  });

  it('starts a pipeline extraction, polls the progress and stops at completed', async () => {
    const { authFetch } = render({
      extract: () => jsonResponse({ id: 'r1', status: 'queued', pct: 0, createdAt: new Date().toISOString() }, { status: 202 }),
      runPolls: [
        { id: 'r1', status: 'running', step: 'statements', pct: 40, details: { model: 'qwen3-4b', progress: { phase: 'claims', done: 2, total: 5 } }, createdAt: new Date().toISOString() },
        { id: 'r1', status: 'completed', step: 'completed', pct: 100, stats: { written: { claims: 7, mentions: 5, findings: 2 } }, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() },
      ],
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Extract' }));
    expect(body(calls(authFetch, `${K}/sources/s1/extract`, 'POST')[0])).toEqual({ mode: 'pipeline' });
    expect(await screen.findByRole('progressbar', { name: 'Extraction' })).toHaveAttribute('aria-valuenow', '0');
    expect(screen.queryByRole('button', { name: 'Extract' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('progressbar', { name: 'Extraction' })).toHaveAttribute('aria-valuenow', '40'), { timeout: 3000 });
    expect(screen.getByText('2/5 passages')).toBeInTheDocument();
    expect(screen.getByText('model qwen3-4b')).toBeInTheDocument();
    expect(await screen.findByText('7 statements · 5 mentions · 2 findings', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Extract' })).toBeInTheDocument();
    const polls = calls(authFetch, `${K}/runs/r1`).length;
    expect(polls).toBe(2);
    await new Promise(r => setTimeout(r, 1700));
    expect(calls(authFetch, `${K}/runs/r1`).length).toBe(polls);
  }, 10000);

  it('sends mode single for the baseline and shows the 409 reason with its setup text', async () => {
    const { authFetch } = render({ extract: () => jsonResponse({ error: 'No local model is configured for this deployment.', setup: 'Runs only on the local model.' }, { ok: false, status: 409 }) });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Baseline: single prompt' }));
    await userEvent.click(screen.getByRole('button', { name: 'Extract' }));
    expect(body(calls(authFetch, `${K}/sources/s1/extract`, 'POST')[0])).toEqual({ mode: 'single' });
    expect(await screen.findByRole('alert')).toHaveTextContent('No local model is configured for this deployment. Runs only on the local model.');
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('follows a run that was already active and cancels it', async () => {
    const active = { id: 'r1', status: 'running', pct: 20, createdAt: new Date().toISOString() };
    const { authFetch } = render({ source: { ...SOURCE, runs: [active, ...SOURCE.runs] }, runPolls: [active] });
    expect(await screen.findByRole('progressbar', { name: 'Extraction' })).toHaveAttribute('aria-valuenow', '20');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls(authFetch, `${K}/runs/r1/cancel`, 'POST')).toHaveLength(1);
    expect(await screen.findByText(/Cancel requested/)).toBeInTheDocument();
  });

  it('says so when the cancel is refused', async () => {
    const active = { id: 'r1', status: 'running', pct: 20, createdAt: new Date().toISOString() };
    render({ source: { ...SOURCE, runs: [active] }, runPolls: [active], cancel: jsonResponse({ error: 'The run is not queued or running.' }, { ok: false, status: 409 }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('The run was not cancelled: The run is not queued or running.')).toBeInTheDocument();
  });
});

describe('TranscriptDetail — statements', () => {
  it('renders subject → predicate (qualifier) → object with badges and the quote marked inside its passage', async () => {
    render();
    const row = await screen.findByRole('listitem', { name: 'Anna works for customer Contoso' });
    expect(row).toHaveTextContent('works for customer (billing)');
    expect(within(row).getByText('stated')).toBeInTheDocument();
    expect(within(row).getByText('supported')).toBeInTheDocument();
    expect(within(row).getByText('proposed')).toBeInTheDocument();
    const mark = row.querySelector('mark');
    expect(mark).toHaveTextContent(/^works for Contoso$/);
    expect(mark.closest('blockquote')).toHaveTextContent('§2She also works for Contoso on billing.');
    expect(screen.getByRole('region', { name: 'High confidence' })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Group by' }), 'Topic');
    expect(screen.getByRole('region', { name: 'Topic customers' })).toBeInTheDocument();
  });

  it('accepts with the status the reviewer saw as expectedStatus, then refetches', async () => {
    const { authFetch } = render();
    const row = await screen.findByRole('listitem', { name: 'Anna works for customer Contoso' });
    const loads = calls(authFetch, `${K}/sources/s1/claims`).length;
    await userEvent.click(within(row).getByRole('button', { name: 'Accept' }));
    const put = calls(authFetch, `${K}/claims/c1`, 'PUT');
    expect(put).toHaveLength(1);
    expect(body(put[0])).toEqual({ status: 'accepted', expectedStatus: 'proposed' });
    await waitFor(() => expect(calls(authFetch, `${K}/sources/s1/claims`).length).toBe(loads + 1));
  });

  it('shows the 409 message when someone else decided first, and refetches', async () => {
    const { authFetch } = render({ claimPut: () => jsonResponse({ error: 'The statement was already set to "accepted" by someone else; reload to see it.' }, { ok: false, status: 409 }) });
    const row = await screen.findByRole('listitem', { name: 'Anna works for customer Contoso' });
    const loads = calls(authFetch, `${K}/sources/s1/claims`).length;
    await userEvent.click(within(row).getByRole('button', { name: 'Reject' }));
    expect(body(calls(authFetch, `${K}/claims/c1`, 'PUT')[0])).toEqual({ status: 'rejected', expectedStatus: 'proposed' });
    expect(await screen.findByText(/Not saved: The statement was already set to "accepted" by someone else/)).toBeInTheDocument();
    await waitFor(() => expect(calls(authFetch, `${K}/sources/s1/claims`).length).toBe(loads + 1));
  });

  it('edits the predicate and qualifier, keeping the status', async () => {
    const { authFetch } = render();
    const row = await screen.findByRole('listitem', { name: 'Anna works for customer Contoso' });
    await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    await userEvent.selectOptions(within(row).getByRole('combobox', { name: 'Predicate' }), 'memberOf');
    const q = within(row).getByRole('textbox', { name: 'Qualifier' });
    await userEvent.clear(q);
    await userEvent.type(q, 'chair');
    await userEvent.click(within(row).getByRole('button', { name: 'Save' }));
    expect(body(calls(authFetch, `${K}/claims/c1`, 'PUT')[0])).toEqual({ status: 'proposed', expectedStatus: 'proposed', predicate: 'memberOf', qualifier: 'chair' });
  });

  it('filters by status: proposed by default, the verifier\'s rejections under rejected', async () => {
    const { authFetch } = render({ claims: (url) => (url.includes('status=rejected') ? [VERIFIER_REJECTED] : [CLAIM]) });
    await screen.findByRole('listitem', { name: 'Anna works for customer Contoso' });
    expect(calls(authFetch, `${K}/sources/s1/claims`)[0][0]).toBe(`${K}/sources/s1/claims?status=proposed`);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Rejected');
    const row = await screen.findByRole('listitem', { name: 'Anna leads Contoso' });
    expect(within(row).getByText('rejected by the verifier')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Reject' })).toBeNull();
    await userEvent.click(within(row).getByRole('button', { name: 'Back to proposed' }));
    expect(body(calls(authFetch, `${K}/claims/c2`, 'PUT')[0])).toEqual({ status: 'proposed', expectedStatus: 'rejected' });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'All');
    await waitFor(() => expect(calls(authFetch, `${K}/sources/s1/claims`).some(([u]) => u === `${K}/sources/s1/claims`)).toBe(true));
  });
});

describe('TranscriptDetail — mentions, findings, source, export', () => {
  const openTab = async (name) => {
    await screen.findByRole('heading', { name: 'Intake Anna' });
    await userEvent.click(screen.getByRole('tab', { name }));
  };

  it('lists open mentions first, with resolution, confidence and why matched', async () => {
    render();
    await openTab('Mentions');
    const regions = await screen.findAllByRole('region', { name: /^Mention / });
    expect(regions.map(r => r.getAttribute('aria-label'))).toEqual(['Mention Harbour', 'Mention Anna']);
    expect(regions[0]).toHaveTextContent('no match found');
    expect(regions[0]).toHaveTextContent('No existing object matches this mention.');
    expect(within(regions[0]).queryByRole('button', { name: 'Choose another…' })).toBeNull();
    expect(within(regions[0]).getByRole('button', { name: 'Choose…' })).toBeInTheDocument();
    expect(regions[1]).toHaveTextContent('82%');
    expect(regions[1]).toHaveTextContent('Why: name · matched “Anna”');
    expect(regions[1]).toHaveTextContent('2× in the transcript');
  });

  it('confirms, rejects and resets a candidate with the exact bodies', async () => {
    const { authFetch } = render();
    await openTab('Mentions');
    const anna = within(await screen.findByRole('region', { name: 'Mention Anna' }));
    await clickSettled(anna.getByRole('button', { name: 'Confirm Anna de Vries for Anna' }));
    await clickSettled(anna.getByRole('button', { name: 'Reject Anna de Vries for Anna' }));
    await clickSettled(anna.getByRole('button', { name: 'Reset Anna Smit for Anna' }));
    const puts = calls(authFetch, `${K}/matches/`, 'PUT');
    expect(puts.map(c => [c[0], body(c)])).toEqual([
      [`${K}/matches/l1`, { action: 'confirm' }],
      [`${K}/matches/l1`, { action: 'reject' }],
      [`${K}/matches/l2`, { action: 'reset' }],
    ]);
    expect(anna.queryByRole('button', { name: 'Reject Anna Smit for Anna' })).toBeNull();
  });

  it('opens a candidate in its own detail tab', async () => {
    const { onOpenDetail } = render();
    await openTab('Mentions');
    const anna = within(await screen.findByRole('region', { name: 'Mention Anna' }));
    await userEvent.click(anna.getByRole('button', { name: 'Anna de Vries' }));
    expect(onOpenDetail).toHaveBeenCalledWith('identity', 'i1', 'Anna de Vries');
  });

  it('chooses another object through the search', async () => {
    const { authFetch } = render({ search: (url) => (!url.endsWith('q=anna.v') ? { candidates: [] } : { status: 'candidates', candidates: [{ targetType: 'Principal', targetId: 'u7', label: 'anna.vries@contoso.com', confidence: 90 }] }) });
    await openTab('Mentions');
    const anna = within(await screen.findByRole('region', { name: 'Mention Anna' }));
    await userEvent.click(anna.getByRole('button', { name: 'Choose another…' }));
    const box = anna.getByRole('textbox', { name: 'Search for another object for Anna' });
    await userEvent.clear(box);
    await userEvent.type(box, 'anna.v');
    await userEvent.click(await anna.findByRole('button', { name: 'Choose anna.vries@contoso.com' }));
    const search = calls(authFetch, `${K}/search`).at(-1)[0];
    expect(search).toBe(`${K}/search?type=person&q=anna.v`);
    expect(body(calls(authFetch, `${K}/matches/`, 'PUT')[0])).toEqual({ action: 'choose', targetType: 'Principal', targetId: 'u7' });
    expect(calls(authFetch, `${K}/matches/l1`, 'PUT')).toHaveLength(1);
  });

  it('links a mention WITHOUT candidates by hand, on the mention itself', async () => {
    const { authFetch } = render({ search: (url) => (!url.endsWith('q=Harbour') ? { candidates: [] } : { status: 'candidates', candidates: [{ targetType: 'Context', targetId: 'c9', label: 'Harbour Ops', confidence: 60 }] }) });
    await openTab('Mentions');
    const harbour = within(await screen.findByRole('region', { name: 'Mention Harbour' }));
    await userEvent.click(harbour.getByRole('button', { name: 'Choose…' }));
    await userEvent.click(await harbour.findByRole('button', { name: 'Choose Harbour Ops' }));
    const puts = calls(authFetch, `${K}/mentions/`, 'PUT');
    expect(puts.map(c => [c[0], body(c)])).toEqual([[`${K}/mentions/m3/choose`, { targetType: 'Context', targetId: 'c9' }]]);
    expect(calls(authFetch, `${K}/matches/`, 'PUT')).toHaveLength(0);
  });

  it('dismisses an open finding and reopens a dismissed one', async () => {
    const { authFetch } = render();
    await openTab('Findings');
    const list = within(await screen.findByRole('list', { name: 'Findings' }));
    expect(list.getByText('Since when exactly does Anna lead Harbour?')).toBeInTheDocument();
    await clickSettled(list.getByRole('button', { name: 'Dismiss' }));
    await clickSettled(list.getByRole('button', { name: 'Reopen' }));
    const puts = calls(authFetch, `${K}/findings/`, 'PUT');
    expect(puts.map(c => [c[0], body(c)])).toEqual([[`${K}/findings/f1`, { status: 'dismissed' }], [`${K}/findings/f2`, { status: 'open' }]]);
  });

  it('shows the passages with number, speaker and time', async () => {
    render();
    await openTab('Source');
    const items = within(await screen.findByRole('list', { name: 'Passages' })).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('§1Anna · 1m 5sAnna leads the Harbour team since March.');
    expect(items[1]).toHaveTextContent('§2She also works for Contoso on billing.');
  });

  it('says so when the export fails', async () => {
    render({ exportAnswer: jsonResponse({}, { ok: false, status: 500 }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Export JSON' }));
    expect(await screen.findByText('The export failed: HTTP 500')).toBeInTheDocument();
  });

  it('exports the JSON package under the server\'s file name', async () => {
    render();
    await userEvent.click(await screen.findByRole('button', { name: 'Export JSON' }));
    await waitFor(() => expect(triggerDownload).toHaveBeenCalledWith('knowledge-s1.json', expect.any(Blob)));
  });
});
