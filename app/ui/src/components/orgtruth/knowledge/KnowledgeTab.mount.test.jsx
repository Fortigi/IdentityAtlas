// @vitest-environment jsdom
//
// Org Info → Knowledge, list + import: the transcripts table, the model status
// banner, "Add transcript" by paste (exact JSON body) and by file (multipart),
// the duplicate answer opening the existing transcript, a refused upload shown
// inline, and read-only for a reader.
import { describe, it, expect } from 'vitest';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent, waitFor, within, fireEvent } from '@ui/test-utils/renderWithProviders';
import KnowledgeTab from './KnowledgeTab';

const WRITER = { hasWildcard: false, permissions: new Set(['data.read', 'data.write.contexts']) };
const READER = { hasWildcard: false, permissions: new Set(['data.read']) };
const FEATURES = { orgTruth: true, knowledgeExtraction: true };

const LISTED = {
  id: 's1', displayName: 'Intake Anna', observedAt: '2026-10-01T00:00:00Z', passageCount: 12,
  metadata: { speaker: 'Anna de Vries', passageCount: 12 }, lastRun: { id: 'r1', status: 'running', pct: 35 },
};
const READY = { configured: true, reachable: true, model: 'qwen3-4b', state: 'ok', activeRunId: null, setup: null };
const DETAIL = (id, name) => ({ id, displayName: name, observedAt: '2026-10-02T00:00:00Z', metadata: {}, passages: [], runs: [] });

function render({ auth = WRITER, status = READY, sources = [LISTED], upload } = {}) {
  const authFetch = makeAuthFetch((url, opts) => {
    if (url === '/api/org-truth/knowledge/status') return status;
    if (url === '/api/org-truth/knowledge/sources' && opts.method === 'POST') return upload(opts);
    if (url === '/api/org-truth/knowledge/sources') return sources;
    const m = /^\/api\/org-truth\/knowledge\/sources\/([^/?]+)$/.exec(url);
    if (m) return DETAIL(m[1], m[1] === 's1' ? 'Intake Anna' : 'Existing call');
    if (url.includes('/claims')) return [];
    return undefined;
  });
  renderWithProviders(<KnowledgeTab onOpenDetail={() => {}} />, { auth: { authFetch, ...auth }, features: FEATURES });
  return { authFetch };
}

const posts = (af) => af.mock.calls.filter(([u, o]) => u === '/api/org-truth/knowledge/sources' && o?.method === 'POST');

describe('KnowledgeTab', () => {
  it('lists the transcripts with date, speaker, passages and the running pct', async () => {
    render();
    const table = await screen.findByRole('table', { name: 'Transcripts' });
    const row = within(table).getByRole('button', { name: 'Intake Anna' }).closest('tr');
    expect(row).toHaveTextContent('Anna de Vries');
    expect(row).toHaveTextContent('12');
    expect(row).toHaveTextContent('running');
    expect(row).toHaveTextContent('35%');
    expect(await screen.findByText('qwen3-4b')).toBeInTheDocument();
  });

  it('shows the setup text when no model is configured, and never a cloud fallback', async () => {
    render({ status: { configured: false, reachable: false, setup: 'Enable the report generator: NL_REPORTS_LLM_URL.' } });
    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('No local model is configured for this deployment.');
    expect(banner).toHaveTextContent('Enable the report generator: NL_REPORTS_LLM_URL.');
  });

  it('says the model is unreachable when configured but down', async () => {
    render({ status: { configured: true, reachable: false, setup: null } });
    expect(await screen.findByRole('status')).toHaveTextContent('The local model is not reachable right now.');
  });

  it('shows an empty state without transcripts', async () => {
    render({ sources: [] });
    expect(await screen.findByText('No transcripts yet')).toBeInTheDocument();
  });

  it('adds a pasted transcript with the exact JSON body, then opens it', async () => {
    const { authFetch } = render({ upload: () => jsonResponse({ id: 's9', displayName: 'Call', duplicate: false }, { status: 201 }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Add transcript' }));
    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Or paste the transcript' }), 'Anna: I lead Harbour.');
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Call');
    await userEvent.type(screen.getByRole('textbox', { name: 'Speaker' }), 'Anna');
    await userEvent.type(screen.getByRole('textbox', { name: 'Language' }), 'nl');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Source type' }), 'meeting');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Classification' }), 'confidential');
    await userEvent.click(add);
    await waitFor(() => expect(posts(authFetch)).toHaveLength(1));
    const [, opts] = posts(authFetch)[0];
    expect(opts.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(opts.body)).toEqual({
      text: 'Anna: I lead Harbour.', displayName: 'Call', speaker: 'Anna', language: 'nl', sourceType: 'meeting', classification: 'confidential',
    });
    expect(await screen.findByText('Transcript added.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Existing call' })).toBeInTheDocument();
    expect(authFetch.mock.calls.some(([u]) => u === '/api/org-truth/knowledge/sources/s9')).toBe(true);
  });

  it('opens the existing transcript when the same text was imported before', async () => {
    render({ upload: () => ({ id: 's1', displayName: 'Intake Anna', duplicate: true }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Add transcript' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Or paste the transcript' }), 'same text');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Already imported — opening it.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Intake Anna' })).toBeInTheDocument();
  });

  it('uploads a chosen file as multipart, without a JSON content type', async () => {
    const { authFetch } = render({ upload: () => jsonResponse({ id: 's9', duplicate: false }, { status: 201 }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Add transcript' }));
    const file = new File(['WEBVTT'], 'call.vtt', { type: 'text/vtt' });
    await userEvent.upload(screen.getByLabelText('File (.txt, .md, .srt, .vtt)'), file);
    expect(screen.queryByRole('textbox', { name: 'Or paste the transcript' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-10-05' } });
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(posts(authFetch)).toHaveLength(1));
    const [, opts] = posts(authFetch)[0];
    expect(opts.headers).toBeUndefined();
    expect(opts.body).toBeInstanceOf(FormData);
    expect(opts.body.get('file').name).toBe('call.vtt');
    expect(opts.body.get('observedAt')).toBe('2026-10-05');
    expect(opts.body.get('sourceType')).toBe('interview');
  });

  it('shows a refused upload inline and keeps the form open', async () => {
    render({ upload: () => jsonResponse({ error: 'language must look like "nl" or "nl-NL".' }, { ok: false, status: 400 }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Add transcript' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Or paste the transcript' }), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The transcript was not added: language must look like "nl" or "nl-NL".');
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Add transcript' })).toBeNull();
  });

  it('offers no Add transcript to a reader, and opens a transcript and comes back', async () => {
    const { authFetch } = render({ auth: READER });
    await userEvent.click(await screen.findByRole('button', { name: 'Intake Anna' }));
    expect(screen.queryByRole('button', { name: 'Add transcript' })).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Intake Anna' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Extract' })).toBeNull();
    const lists = () => authFetch.mock.calls.filter(([u]) => u === '/api/org-truth/knowledge/sources').length;
    const before = lists();
    await userEvent.click(screen.getByRole('button', { name: '← All transcripts' }));
    await screen.findByRole('table', { name: 'Transcripts' });
    expect(lists()).toBe(before + 1);
  });
});
