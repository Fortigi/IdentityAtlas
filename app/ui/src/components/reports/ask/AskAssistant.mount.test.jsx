// @vitest-environment jsdom
//
// "Describe the report you want" — what this pins down:
//   • with no model server there is no question box at all, and the reason the
//     API gave (model missing vs. server unreachable) is the reason shown
//   • while the prompt cache is still being prepared the analyst is warned that
//     questions are slow — but may still ask one
//   • a reply that carries a definition is handed to the builder together with
//     the question that produced it; the builder's own (hand-edited) definition
//     is sent along as the last thing said
//   • a clarifying question is answered with the conversation so far attached,
//     so the model can connect the answer to what it asked
//   • a "did you mean …?" is applied by /resolve alone — the model is not asked
//     again — and the resolved definition (not the unresolved one) is reported
//   • an endpoint error is shown verbatim, with its detail lines, and the box
//     stays usable for the next attempt
//
// The fixtures deliberately use a model name, spec and suggestion the component
// could not have hardcoded, so what is asserted is that the API's answer reached
// the screen rather than that some plausible text exists.
import { describe, it, expect, vi } from 'vitest';
import {
  renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent, waitFor,
} from '@ui/test-utils/renderWithProviders';
import AskAssistant from './AskAssistant';

const READY_STATUS = {
  available: true, model: 'qwen2.5-coder:7b', loaded: true, promptCache: 'ready', reason: null,
};

const SPEC = { entity: 'user', where: { all: [{ field: 'userType', op: 'is', value: 'Guest' }] }, columns: ['displayName'] };
const RESOLVED_SPEC = { ...SPEC, where: { all: [{ field: 'memberOf', op: 'is', value: 'Fortigi - Algemeen - Maten', id: 'br1' }] } };

const REPORT_REPLY = {
  kind: 'report',
  spec: SPEC,
  assumptions: ['"Guest" means userType Guest, not an external mail contact'],
  raw: '{"kind":"report","spec":{}}',
  timing: { totalMs: 2500, promptMs: 1500, outputMs: 1000, promptTokens: 1200, outputTokens: 80 },
};

const CLARIFY_REPLY = {
  kind: 'clarify',
  question: 'Do you mean accounts with no manager set, or accounts whose manager is disabled?',
  options: ['No manager set', 'Manager is disabled'],
  raw: '{"kind":"clarify"}',
  timing: null,
};

const CONFIRM_REPLY = {
  kind: 'confirm',
  spec: SPEC,
  confirm: {
    kind: 'reference',
    path: [0],
    name: 'Algemene maten',
    label: 'business role',
    message: 'No business role is named exactly "Algemene maten". Did you mean:',
    choices: [{ id: 'br1', name: 'Fortigi - Algemeen - Maten', type: 'BusinessRole', score: 0.61 }],
  },
  raw: '{"kind":"confirm"}',
  timing: { totalMs: 900, promptMs: 600, outputMs: 300, promptTokens: 1200, outputTokens: 20 },
};

// `interpret` / `warm` / `resolve` each take a body or a (url, opts) handler, so
// a test can answer differently per call.
function renderAsk({
  status = READY_STATUS,
  warm = { state: 'ready' },
  interpret,
  resolve,
  ...props
} = {}) {
  const pick = (stub, url, opts) => (typeof stub === 'function' ? stub(url, opts) : stub);
  const authFetch = makeAuthFetch((url, opts) => {
    const s = String(url);
    if (s.includes('/nl-reports/status')) return pick(status, s, opts);
    if (s.includes('/nl-reports/warm')) return pick(warm, s, opts);
    if (s.includes('/nl-reports/interpret')) return pick(interpret, s, opts);
    if (s.includes('/nl-reports/resolve')) return pick(resolve, s, opts);
    return undefined;
  });
  const onReport = vi.fn();
  const rendered = renderWithProviders(
    <AskAssistant onReport={onReport} {...props} />,
    { auth: { authFetch } },
  );
  return { ...rendered, onReport };
}

// The JSON bodies actually posted to one endpoint, in order — without the
// conversation id, which every /interpret carries since the conversation store
// and is asserted on its own below. Leaving it in would make every exact-body
// assertion in this file repeat the same expect.any(String).
const bodiesFor = (authFetch, path) => authFetch.mock.calls
  .filter(([url]) => String(url).includes(path))
  .map(([, opts]) => { const { conversationId, ...body } = JSON.parse(opts.body); return body; });

/** The conversation ids /interpret was sent, in order. */
const threadsFor = (authFetch) => authFetch.mock.calls
  .filter(([url]) => String(url).includes('/nl-reports/interpret'))
  .map(([, opts]) => JSON.parse(opts.body).conversationId);

const questionBox = (name = /Describe the report you want/) => screen.getByRole('textbox', { name });

// Answers `serve` on the first call to an endpoint and REPORT_REPLY afterwards.
function thenReport(serve) {
  let n = 0;
  return () => (n++ === 0 ? serve : REPORT_REPLY);
}

describe('AskAssistant', () => {
  it('names the model that is missing and offers no question box at all', async () => {
    const { authFetch } = renderAsk({
      status: { available: false, model: 'qwen2.5-coder:7b', loaded: false, promptCache: 'idle', reason: 'model-not-installed' },
    });

    expect(await screen.findByText(/model "qwen2\.5-coder:7b" is not installed/)).toBeInTheDocument();
    expect(screen.getByText(/definition editor below/)).toBeInTheDocument();
    // Nothing to type into and nothing to press — the builder is the way out.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // And no model is loaded on behalf of a server that isn't there.
    expect(bodiesFor(authFetch, '/nl-reports/warm')).toHaveLength(0);
  });

  it('blames the unreachable server, not a missing model, when that is the reason given', async () => {
    renderAsk({ status: { available: false, model: 'qwen2.5-coder:7b', reason: 'server-unreachable' } });

    expect(await screen.findByText(/the local model server is not reachable/)).toBeInTheDocument();
    expect(screen.queryByText(/is not installed/)).not.toBeInTheDocument();
  });

  it('warns that questions are slow while the prompt cache is being prepared, and still lets one be asked', async () => {
    const { authFetch } = renderAsk({
      status: { ...READY_STATUS, loaded: false, promptCache: 'preparing' },
      warm: { state: 'preparing', message: 'The model is preparing its prompt cache.' },
      interpret: REPORT_REPLY,
    });

    expect(await screen.findByText(/preparing its prompt cache .* questions work but are slow/)).toBeInTheDocument();

    await userEvent.type(questionBox(), 'groups with Finance in the name');
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(bodiesFor(authFetch, '/nl-reports/interpret')).toHaveLength(1));
  });

  it('loads an unloaded model as soon as the builder opens, shows the wait, and clears it once loaded', async () => {
    // The model is unloaded after a while unused, so opening the builder is what
    // brings it back. The first answers say it is loading; then it is ready.
    const answers = [{ state: 'starting' }, { state: 'starting' }, { state: 'ready', model: 'm', ms: 9000, restored: true }];
    const { authFetch } = renderAsk({
      status: { ...READY_STATUS, loaded: false, promptCache: 'ready' },
      warm: () => answers.shift() ?? { state: 'ready' },
    });

    expect(await screen.findByText(/loading the model into memory — usually under a minute… \d+s/)).toBeInTheDocument();
    // Not the minutes-long cache message: this wait is seconds.
    expect(screen.queryByText(/preparing its prompt cache/)).not.toBeInTheDocument();

    // It polls quickly while loading (every 2 s), and the message goes once it is in.
    await waitFor(() => expect(screen.queryByText(/loading the model/)).not.toBeInTheDocument(), { timeout: 8000 });
    expect(bodiesFor(authFetch, '/nl-reports/warm')).toHaveLength(3);
  }, 15000);

  it('does not load the model when it is already in memory', async () => {
    const { authFetch } = renderAsk({ status: { ...READY_STATUS, loaded: true, promptCache: 'ready' } });
    await screen.findByRole('button', { name: 'Generate' });
    expect(screen.queryByText(/loading the model/)).not.toBeInTheDocument();
    // One cheap warm call still re-checks the cache; it never shows a wait.
    await waitFor(() => expect(bodiesFor(authFetch, '/nl-reports/warm').length).toBeLessThanOrEqual(1));
  });

  it('says the model server did not respond when warming it up fails', async () => {
    renderAsk({ warm: jsonResponse({ error: 'The local model server is not reachable or failed.' }, { ok: false, status: 502 }) });

    expect(await screen.findByText('model server did not respond')).toBeInTheDocument();
    // A failed warm-up is not a dead end: the question box is still there.
    expect(questionBox()).toBeEnabled();
  });

  it('hands the generated definition, and the trimmed question that produced it, to the builder', async () => {
    const { authFetch, onReport } = renderAsk({ interpret: REPORT_REPLY });

    await userEvent.type(await screen.findByRole('textbox', { name: /Describe the report you want/ }), '  guest accounts without a manager  ');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(onReport).toHaveBeenCalledWith(REPORT_REPLY, 'guest accounts without a manager', expect.any(String)));
    expect(onReport).toHaveBeenCalledTimes(1);
    // The stub matches URLs by substring, so pin the exact endpoint and verb here.
    expect(authFetch).toHaveBeenCalledWith('/api/nl-reports/interpret', expect.objectContaining({ method: 'POST' }));
    expect(bodiesFor(authFetch, '/nl-reports/interpret')).toEqual([
      { question: 'guest accounts without a manager', history: [] },
    ]);
    // What the analyst asked, what the model assumed, and what it cost.
    expect(screen.getByText('guest accounts without a manager')).toBeInTheDocument();
    expect(screen.getByRole('listitem')).toHaveTextContent(REPORT_REPLY.assumptions[0]);
    expect(screen.getByText('2.5s · read 1200 tokens in 1.5s · wrote 80 tokens in 1.0s')).toBeInTheDocument();
  });

  it('sends the definition currently in the builder as the last thing said, and asks to update it', async () => {
    const edited = { ...SPEC, columns: ['displayName', 'department'] };
    const { authFetch } = renderAsk({ currentSpec: edited, interpret: REPORT_REPLY });

    await userEvent.type(await screen.findByRole('textbox', { name: /Describe a change to the report/ }), 'also show the department');
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(bodiesFor(authFetch, '/nl-reports/interpret')).toEqual([{
      question: 'also show the department',
      history: [
        { role: 'user', content: 'This is the current report definition.' },
        { role: 'assistant', content: JSON.stringify({ kind: 'report', assumptions: [], spec: edited }) },
      ],
    }]));
    expect(screen.queryByRole('button', { name: 'Generate' })).not.toBeInTheDocument();
  });

  it('shows the clarifying question and sends the chosen answer with the conversation so far', async () => {
    const { authFetch, onReport } = renderAsk({ interpret: thenReport(CLARIFY_REPLY) });

    await userEvent.type(await screen.findByRole('textbox', { name: /Describe the report you want/ }), 'accounts without a manager');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

    expect(await screen.findByText(CLARIFY_REPLY.question)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manager is disabled' })).toBeInTheDocument();
    expect(onReport).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'No manager set' }));

    // The answer alone ("No manager set") is meaningless without the question it
    // answers, so the previous turn travels with it.
    await waitFor(() => expect(bodiesFor(authFetch, '/nl-reports/interpret')[1]).toEqual({
      question: 'No manager set',
      history: [
        { role: 'user', content: 'accounts without a manager' },
        { role: 'assistant', content: CLARIFY_REPLY.raw },
      ],
    }));
    await waitFor(() => expect(onReport).toHaveBeenCalledWith(REPORT_REPLY, 'No manager set', expect.any(String)));
  });

  it('lets the model decide, sending that as the answer rather than an empty one', async () => {
    const { authFetch } = renderAsk({ interpret: thenReport(CLARIFY_REPLY) });

    await userEvent.type(await screen.findByRole('textbox', { name: /Describe the report you want/ }), 'accounts without a manager');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Use your best guess' }));

    await waitFor(() => expect(bodiesFor(authFetch, '/nl-reports/interpret')[1].question)
      .toBe('Use your best judgement and produce the report.'));
  });

  it('applies the record the analyst picked without asking the model again, and reports the resolved definition', async () => {
    const { authFetch, onReport } = renderAsk({
      interpret: CONFIRM_REPLY,
      resolve: { spec: RESOLVED_SPEC, explanation: 'Users in business role Fortigi - Algemeen - Maten' },
    });

    await userEvent.type(await screen.findByRole('textbox', { name: /Describe the report you want/ }), 'members of algemene maten');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

    expect(await screen.findByText(CONFIRM_REPLY.confirm.message)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Fortigi - Algemeen - Maten/ }));

    await waitFor(() => expect(bodiesFor(authFetch, '/nl-reports/resolve')).toEqual([
      { spec: SPEC, choice: { path: [0], name: 'Fortigi - Algemeen - Maten', id: 'br1' } },
    ]));
    // The builder gets the spec /resolve rewrote, still attributed to the
    // original question — not to the choice the analyst clicked.
    await waitFor(() => expect(onReport).toHaveBeenCalledWith({
      ...CONFIRM_REPLY,
      kind: 'report',
      spec: RESOLVED_SPEC,
      explanation: 'Users in business role Fortigi - Algemeen - Maten',
    }, 'members of algemene maten', expect.any(String)));
    expect(screen.getByText('Using “Fortigi - Algemeen - Maten”.')).toBeInTheDocument();
    // One model round-trip for the whole exchange.
    expect(bodiesFor(authFetch, '/nl-reports/interpret')).toHaveLength(1);
  });

  it('shows the endpoint error and leaves the box usable for another attempt', async () => {
    const { onReport } = renderAsk({
      interpret: thenReport(jsonResponse(
        { error: 'The local model server is not reachable or failed.' }, { ok: false, status: 502 },
      )),
    });

    await userEvent.type(await screen.findByRole('textbox', { name: /Describe the report you want/ }), 'all guest accounts');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The local model server is not reachable or failed.');
    expect(onReport).not.toHaveBeenCalled();
    expect(questionBox()).toBeEnabled();

    await userEvent.type(questionBox(), 'all guest accounts');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(onReport).toHaveBeenCalledWith(REPORT_REPLY, 'all guest accounts', expect.any(String)));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the detail lines the endpoint sent with a rejected definition', async () => {
    renderAsk({
      interpret: jsonResponse(
        { error: 'Invalid report definition', errors: ['unknown field "manger"', 'operator "over" needs a value'] },
        { ok: false, status: 400 },
      ),
    });

    await userEvent.type(await screen.findByRole('textbox', { name: /Describe the report you want/ }), 'users whose manger is empty');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invalid report definition: unknown field "manger"; operator "over" needs a value');
  });

  it('asks an example question straight away, then stops offering the examples', async () => {
    const { authFetch } = renderAsk({ interpret: REPORT_REPLY });

    const example = await screen.findByRole('button', { name: 'Groups that have "Finance" in the name' });
    await userEvent.click(example);

    await waitFor(() => expect(bodiesFor(authFetch, '/nl-reports/interpret')).toEqual([
      { question: 'Groups that have "Finance" in the name', history: [] },
    ]));
    await waitFor(() => expect(
      screen.queryByRole('button', { name: 'Groups that have "Finance" in the name' })).not.toBeInTheDocument());
  });

  it('submits on Enter and keeps Shift+Enter for a second line', async () => {
    const { authFetch } = renderAsk({ interpret: REPORT_REPLY });

    const box = await screen.findByRole('textbox', { name: /Describe the report you want/ });
    await userEvent.type(box, 'disabled users{Shift>}{Enter}{/Shift}still in a group');
    expect(bodiesFor(authFetch, '/nl-reports/interpret')).toHaveLength(0);

    await userEvent.type(box, '{Enter}');
    await waitFor(() => expect(bodiesFor(authFetch, '/nl-reports/interpret')).toEqual([
      { question: 'disabled users\nstill in a group', history: [] },
    ]));
  });
});

describe('the conversation thread', () => {
  it('sends one conversation id with every question, so the store can thread them', async () => {
    const { authFetch } = renderAsk({ interpret: thenReport(CLARIFY_REPLY) });
    await userEvent.type(await screen.findByRole('textbox'), 'accounts without a manager');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await userEvent.click(await screen.findByRole('button', { name: 'No manager set' }));

    await waitFor(() => expect(threadsFor(authFetch)).toHaveLength(2));
    const [first, second] = threadsFor(authFetch);
    expect(first).toMatch(/^[A-Za-z0-9:_-]{1,100}$/);
    expect(second).toBe(first);
  });
});

describe('AskAssistant — a question the assistant declines', () => {
  it('shows the one-sentence reason and hands nothing to the builder', async () => {
    const authFetch = makeAuthFetch((url) => {
      if (String(url).includes('/nl-reports/status')) return jsonResponse({ available: true, model: 'm', warm: 'ready' });
      if (String(url).includes('/nl-reports/interpret')) return jsonResponse({ kind: 'decline', reason: 'I only build reports on the directory.', raw: '{}' });
      return jsonResponse({});
    });
    const onReport = vi.fn();
    renderWithProviders(<AskAssistant onReport={onReport} />, { auth: { authFetch } });
    const box = await screen.findByRole('textbox');
    await userEvent.type(box, 'Is Trump the president of the United States?{enter}');
    expect(await screen.findByText('I only build reports on the directory.')).toBeInTheDocument();
    expect(onReport).not.toHaveBeenCalled();
  });
});
