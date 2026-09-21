import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/connection.js');
vi.mock('../nlreports/service.js', async (importOriginal) => ({
  // applyResolveChoice is real: the "answering a did-you-mean" path below is
  // its behaviour, and a stub would make those tests assert the stub.
  applyResolveChoice: (await importOriginal()).applyResolveChoice,
  interpret: vi.fn(),
  runSpec: vi.fn(),
  loadValues: vi.fn(async () => ({ principalType: ['User'] })),
  ensureWarm: vi.fn(),
  warmupState: vi.fn(() => 'ready'),
}));

import { answerMessage, withDeadline, matchChoice, toAppliedChoice, isHelp, defaultReportLink, TIMED_OUT, DEADLINE_MS, PROGRESS_AFTER_MS } from './service.js';
import { clearPending } from './state.js';
import { EN, NL } from './text.js';
import { CALLER_SENTINEL } from '../nlreports/spec.js';

const OID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CALLER = { principalId: OID, displayName: 'Wim van den Heijkant', email: 'wim@example.com' };

const text = (card) => JSON.stringify(card.content.body);

const reportSpec = {
  entity: 'user', match: 'all',
  conditions: [{ type: 'relation', relation: 'manager', quantifier: 'some', match: 'all',
    conditions: [{ type: 'field', field: 'id', op: 'eq', value: CALLER_SENTINEL }] }],
  columns: ['displayName'],
};

const runResult = (over = {}) => ({
  ok: true,
  explanation: 'Users whose manager is Wim van den Heijkant',
  columns: [{ key: 'displayName', label: 'Name' }],
  rows: [{ displayName: 'Jan', _entity: { kind: 'user', id: 'u1' } }],
  truncated: false,
  elapsedMs: 120,
  ...over,
});

function deps(over = {}) {
  return {
    resolveCaller: vi.fn(async () => CALLER),
    interpret: vi.fn(async () => ({ kind: 'report', spec: structuredClone(reportSpec), timing: { totalMs: 49_000 } })),
    runSpec: vi.fn(async () => runResult()),
    log: vi.fn(async (e) => e.id),
    reportLink: (id) => `https://ia.example/#bot-answer:${id}`,
    ...over,
  };
}

const msg = (over = {}) => ({ oid: OID, conversationId: 'conv-1', text: 'which of my direct reports are there?', ...over });

beforeEach(() => {
  clearPending();
  vi.clearAllMocks();
});

describe('answerMessage — the caller', () => {
  it('stops at an unknown caller and never reaches the model', async () => {
    const d = deps({ resolveCaller: vi.fn(async () => null) });
    const out = await answerMessage(msg(), d);

    expect(out.outcome).toBe('unknown-caller');
    expect(text(out.attachment)).toContain(EN.unknownCaller);
    expect(d.interpret).not.toHaveBeenCalled();
    expect(d.runSpec).not.toHaveBeenCalled();
  });

  it('logs the unknown caller, so exposure stays auditable even when nothing was answered', async () => {
    const d = deps({ resolveCaller: vi.fn(async () => null) });
    await answerMessage(msg(), d);

    expect(d.log).toHaveBeenCalledTimes(1);
    const entry = d.log.mock.calls[0][0];
    expect(entry.outcome).toBe('unknown-caller');
    expect(entry.callerOid).toBe(OID);
    expect(entry.callerPrincipalId).toBeNull();
  });

  it('answers help without resolving a caller or spending the model', async () => {
    const d = deps();
    const out = await answerMessage(msg({ text: 'help' }), d);

    expect(text(out.attachment)).toContain(EN.welcome);
    expect(d.resolveCaller).not.toHaveBeenCalled();
    expect(d.interpret).not.toHaveBeenCalled();
  });
});

describe('answerMessage — "my" resolves to the caller', () => {
  it('puts the caller in the question context, not in the cached system prompt', async () => {
    const d = deps();
    await answerMessage(msg(), d);

    const { question, history } = d.interpret.mock.calls[0][0];
    expect(question).toContain(CALLER.displayName);
    expect(question).toContain(OID);
    expect(question).toContain('which of my direct reports are there?');
    expect(history).toEqual([]);
  });

  it('substitutes the caller\'s account id into the definition BEFORE running it', async () => {
    // The single most important assertion in this file: what runs must carry
    // the caller's real id, not the sentinel and not someone else's.
    const d = deps();
    await answerMessage(msg(), d);

    const ran = d.runSpec.mock.calls[0][0];
    expect(ran.conditions[0].conditions[0].value).toBe(OID);
    expect(JSON.stringify(ran)).not.toContain(CALLER_SENTINEL);
  });

  it('logs the substituted definition, which is what the deep link re-runs', async () => {
    const d = deps();
    await answerMessage(msg(), d);

    const entry = d.log.mock.calls[0][0];
    expect(entry.definition.conditions[0].conditions[0].value).toBe(OID);
  });

  it('warns when a possessive question produced a directory-wide report', async () => {
    // The report has no reference to the caller, but the question said "my".
    const d = deps({
      interpret: vi.fn(async () => ({
        kind: 'report',
        spec: { entity: 'user', match: 'all', conditions: [{ type: 'field', field: 'displayName', op: 'contains', value: 'a' }], columns: ['displayName'] },
        timing: { totalMs: 1 },
      })),
    });
    const out = await answerMessage(msg({ text: 'which of my people have access?' }), d);
    expect(text(out.attachment)).toContain(EN.scopeCaveat);
  });

  it('does not warn when the report IS anchored to the caller', async () => {
    const out = await answerMessage(msg(), deps());
    expect(text(out.attachment)).not.toContain(EN.scopeCaveat);
  });
});

describe('answerMessage — answering', () => {
  it('returns a card with the rows and records what came back', async () => {
    const d = deps();
    const out = await answerMessage(msg(), d);

    expect(out.outcome).toBe('answered');
    expect(text(out.attachment)).toContain('Jan');

    const entry = d.log.mock.calls[0][0];
    expect(entry.outcome).toBe('answered');
    expect(entry.rowCount).toBe(1);
    expect(entry.columns).toEqual(['displayName']);
    expect(entry.modelMs).toBe(49_000);
    expect(entry.queryMs).toBe(120);
    expect(entry.truncated).toBe(false);
  });

  it('answers zero rows as an answer, not as a failure', async () => {
    const d = deps({ runSpec: vi.fn(async () => runResult({ rows: [] })) });
    const out = await answerMessage(msg(), d);

    expect(out.outcome).toBe('answered');
    expect(text(out.attachment)).toContain(EN.noResults);
    expect(d.log.mock.calls[0][0].rowCount).toBe(0);
  });

  it('links to the full report only when the card cannot show all of it', async () => {
    // Eleven rows needs a link; ten does not. The boundary, both sides.
    const eleven = Array.from({ length: 11 }, (_, i) => ({ displayName: `u${i}` }));
    const ten = eleven.slice(0, 10);

    const linked = await answerMessage(msg(), deps({ runSpec: vi.fn(async () => runResult({ rows: eleven })) }));
    expect(linked.attachment.content.actions?.[0].url).toContain('#bot-answer:');

    const unlinked = await answerMessage(msg(), deps({ runSpec: vi.fn(async () => runResult({ rows: ten })) }));
    expect(unlinked.attachment.content.actions).toBeUndefined();
  });

  it('links when there are more columns than the card shows, even with one row', async () => {
    const columns = Array.from({ length: 5 }, (_, i) => ({ key: `c${i}`, label: `C${i}` }));
    const out = await answerMessage(msg(), deps({ runSpec: vi.fn(async () => runResult({ columns })) }));
    expect(out.attachment.content.actions?.[0].url).toContain('#bot-answer:');
  });

  it('answers a Dutch question with Dutch chrome and logs the language', async () => {
    const d = deps({ runSpec: vi.fn(async () => runResult({ rows: [] })) });
    const out = await answerMessage(msg({ text: 'welke van mijn medewerkers hebben toegang?' }), d);

    expect(text(out.attachment)).toContain(NL.noResults);
    expect(d.log.mock.calls[0][0].language).toBe('nl');
  });
});

describe('answerMessage — when the model is unsure', () => {
  it('asks one clarifying question and records that it did', async () => {
    const d = deps({
      interpret: vi.fn(async () => ({ kind: 'clarify', question: 'Which kind of admin?', options: ['Directory role', 'App role'], raw: '{}', timing: { totalMs: 30 } })),
    });
    const out = await answerMessage(msg({ text: 'who has admin rights' }), d);

    expect(out.outcome).toBe('clarified');
    expect(text(out.attachment)).toContain('Which kind of admin?');
    expect(text(out.attachment)).toContain('Directory role');
    expect(d.log.mock.calls[0][0].clarification).toBe('Which kind of admin?');
    expect(d.runSpec).not.toHaveBeenCalled();
  });

  it('carries the clarification into the next message instead of starting over', async () => {
    const clarifying = vi.fn(async () => ({ kind: 'clarify', question: 'Which?', options: [], raw: '{"kind":"clarify"}', timing: {} }));
    const d = deps({ interpret: clarifying });
    await answerMessage(msg({ text: 'who has admin rights' }), d);

    // Second turn: the same conversation answers the question.
    d.interpret = vi.fn(async () => ({ kind: 'report', spec: structuredClone(reportSpec), timing: {} }));
    await answerMessage(msg({ text: 'directory role' }), d);

    const second = d.interpret.mock.calls[0][0];
    expect(second.history).toHaveLength(2);
    expect(second.history[1]).toEqual({ role: 'assistant', content: '{"kind":"clarify"}' });
    // The caller block is not repeated — it is already in the history.
    expect(second.question).toBe('directory role');
  });

  it('offers the "did you mean" choices, then applies the answer WITHOUT another model call', async () => {
    const confirm = {
      kind: 'value', path: [0], name: 'Jan',
      label: 'user', message: 'Which Jan did you mean?',
      choices: [{ id: 'u1', name: 'Jan de Vries' }, { id: 'u2', name: 'Jan Jansen' }],
    };
    const spec = { entity: 'user', match: 'all', conditions: [{ type: 'field', field: 'displayName', op: 'eq', value: 'Jan' }], columns: ['displayName'] };
    const d = deps({ interpret: vi.fn(async () => ({ kind: 'confirm', confirm, spec, timing: {} })) });

    const asked = await answerMessage(msg({ text: 'which groups is Jan in' }), d);
    expect(asked.outcome).toBe('clarified');
    expect(text(asked.attachment)).toContain('Jan de Vries');

    d.interpret.mockClear();
    const answered = await answerMessage(msg({ text: 'Jan de Vries' }), d);

    expect(answered.outcome).toBe('answered');
    expect(d.interpret).not.toHaveBeenCalled();
    expect(d.runSpec).toHaveBeenCalledTimes(1);
  });

  it('marks on the card which name a fuzzy match ended up using', async () => {
    // The manager typed "Jan de Vr"; the report ran against "Jan de Vries".
    // Silently using the corrected name is how a page of perfectly formatted
    // answers about the wrong person gets believed.
    const confirm = {
      kind: 'value', path: [0], name: 'Jan de Vr', label: 'user', message: 'Which Jan did you mean?',
      choices: [{ id: 'u1', name: 'Jan de Vries' }],
    };
    const spec = { entity: 'user', match: 'all', conditions: [{ type: 'field', field: 'displayName', op: 'eq', value: 'Jan de Vr' }], columns: ['displayName'] };
    const d = deps({ interpret: vi.fn(async () => ({ kind: 'confirm', confirm, spec, timing: {} })) });

    await answerMessage(msg({ text: 'which groups is Jan de Vr in' }), d);
    const answered = await answerMessage(msg({ text: 'Jan de Vries' }), d);

    expect(answered.outcome).toBe('answered');
    expect(text(answered.attachment)).toContain(EN.fuzzy('Jan de Vr', 'Jan de Vries'));
  });

  it('does not mark a name the caller confirmed exactly as typed', async () => {
    // Same path, but nothing was corrected — a note here would be noise on
    // every confirmed answer and would train people to ignore the real ones.
    const confirm = {
      kind: 'value', path: [0], name: 'Finance', label: 'group', message: 'Which Finance?',
      choices: [{ id: 'g1', name: 'Finance' }],
    };
    const spec = { entity: 'user', match: 'all', conditions: [{ type: 'field', field: 'displayName', op: 'eq', value: 'Finance' }], columns: ['displayName'] };
    const d = deps({ interpret: vi.fn(async () => ({ kind: 'confirm', confirm, spec, timing: {} })) });

    await answerMessage(msg({ text: 'who is in Finance' }), d);
    const answered = await answerMessage(msg({ text: 'Finance' }), d);

    expect(answered.outcome).toBe('answered');
    expect(text(answered.attachment)).not.toContain('was matched to');
  });

  it('treats an unmatched reply to a "did you mean" as a new question', async () => {
    const confirm = { kind: 'value', path: [], name: 'Jan', label: 'user', message: 'Which Jan?', choices: [{ id: 'u1', name: 'Jan de Vries' }] };
    const spec = { entity: 'user', match: 'all', conditions: [], columns: ['displayName'] };
    const d = deps({ interpret: vi.fn(async () => ({ kind: 'confirm', confirm, spec, timing: {} })) });
    await answerMessage(msg({ text: 'which groups is Jan in' }), d);

    d.interpret = vi.fn(async () => ({ kind: 'report', spec: structuredClone(reportSpec), timing: {} }));
    const out = await answerMessage(msg({ text: 'actually, show me all guest accounts' }), d);

    expect(d.interpret).toHaveBeenCalledTimes(1);
    expect(out.outcome).toBe('answered');
  });
});

describe('answerMessage — when it goes wrong', () => {
  it('shows the examples when the definition never validated', async () => {
    const d = deps({ interpret: vi.fn(async () => ({ kind: 'error', message: 'not JSON', errors: ['unknown field "x"'], timing: {} })) });
    const out = await answerMessage(msg({ text: 'asdfgh' }), d);

    expect(out.outcome).toBe('not-understood');
    expect(text(out.attachment)).toContain(EN.notUnderstood);
    for (const example of EN.examples) expect(text(out.attachment)).toContain(example);
    expect(d.log.mock.calls[0][0].error).toContain('unknown field "x"');
  });

  it('treats a definition that would not run as not-understood, not as a crash', async () => {
    const d = deps({ runSpec: vi.fn(async () => ({ ok: false, errors: ['"foo" is not a known value'] })) });
    const out = await answerMessage(msg(), d);

    expect(out.outcome).toBe('not-understood');
    expect(d.log.mock.calls[0][0].outcome).toBe('not-understood');
  });

  it('never leaves a question unanswered when something throws, and keeps the detail out of the chat', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps({ runSpec: vi.fn(async () => { throw new Error('connection terminated unexpectedly'); }) });

    const out = await answerMessage(msg(), d);

    expect(out.outcome).toBe('failed');
    expect(text(out.attachment)).toContain(EN.error);
    expect(text(out.attachment)).not.toContain('connection terminated');
    expect(d.log.mock.calls[0][0].error).toBe('connection terminated unexpectedly');
    err.mockRestore();
  });

  it('gives up at the deadline and says how long it waited', async () => {
    vi.useFakeTimers();
    try {
      const d = deps({ interpret: vi.fn(() => new Promise(() => {})) });
      const promise = answerMessage(msg(), d);
      await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1);
      const out = await promise;

      expect(out.outcome).toBe('timeout');
      expect(text(out.attachment)).toContain(String(Math.round(DEADLINE_MS / 1000)));
      expect(d.log.mock.calls[0][0].outcome).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the caller it is still working before the deadline, once', async () => {
    vi.useFakeTimers();
    try {
      const onProgress = vi.fn(async () => {});
      const d = deps({ interpret: vi.fn(() => new Promise(() => {})), onProgress });
      const promise = answerMessage(msg(), d);

      await vi.advanceTimersByTimeAsync(PROGRESS_AFTER_MS - 1);
      expect(onProgress).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(onProgress).toHaveBeenCalledTimes(1);
      expect(onProgress).toHaveBeenCalledWith(EN.stillWorking);

      await vi.advanceTimersByTimeAsync(DEADLINE_MS);
      await promise;
      expect(onProgress).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not send the interim message when the answer arrives first', async () => {
    vi.useFakeTimers();
    try {
      const onProgress = vi.fn(async () => {});
      const out = await answerMessage(msg(), deps({ onProgress }));
      await vi.advanceTimersByTimeAsync(PROGRESS_AFTER_MS + 1);

      expect(out.outcome).toBe('answered');
      expect(onProgress).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('withDeadline', () => {
  it('returns the value when the work finishes first', async () => {
    await expect(withDeadline(Promise.resolve('done'), 1000)).resolves.toBe('done');
  });

  it('returns the sentinel — not a thrown error — when the deadline wins', async () => {
    vi.useFakeTimers();
    try {
      const race = withDeadline(new Promise(() => {}), 50);
      await vi.advanceTimersByTimeAsync(51);
      await expect(race).resolves.toBe(TIMED_OUT);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a rejection rather than turning it into a timeout', async () => {
    await expect(withDeadline(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
  });
});

describe('matchChoice', () => {
  const confirm = { choices: [{ id: 'u1', name: 'Jan de Vries' }, { id: 'u2', name: 'Jan Jansen' }] };

  it('matches an exact name, ignoring case and surrounding space', () => {
    expect(matchChoice(confirm, '  jan de vries ').id).toBe('u1');
  });

  it('matches a unique fragment', () => {
    expect(matchChoice(confirm, 'jansen').id).toBe('u2');
  });

  it('refuses an ambiguous fragment rather than picking one', () => {
    // "Jan" is in both names. Guessing here answers about the wrong person.
    expect(matchChoice(confirm, 'Jan')).toBeNull();
  });

  it('prefers an exact match over a fragment that also matches it', () => {
    const nested = { choices: [{ id: 'a', name: 'Finance' }, { id: 'b', name: 'Finance Managers' }] };
    expect(matchChoice(nested, 'Finance').id).toBe('a');
  });

  it('returns null for an empty reply or no choices', () => {
    expect(matchChoice(confirm, '')).toBeNull();
    expect(matchChoice(confirm, '   ')).toBeNull();
    expect(matchChoice({ choices: [] }, 'Jan')).toBeNull();
    expect(matchChoice(null, 'Jan')).toBeNull();
  });
});

describe('toAppliedChoice', () => {
  it('turns a name confirmation into the path-carrying shape applyChoice needs', () => {
    // The choice as OFFERED knows which record was picked; only the
    // confirmation knows which condition it belongs to. Dropping the path here
    // produces a choice that validates and applies to nothing.
    const confirm = { kind: 'value', path: [0], name: 'Jan', choices: [] };
    expect(toAppliedChoice(confirm, { id: 'u1', name: 'Jan de Vries' }))
      .toEqual({ kind: 'value', path: [0], name: 'Jan de Vries', id: 'u1' });
  });

  it('turns a term confirmation into the term + fields shape, not a name + path', () => {
    // A term confirmation is answered by saying WHICH FIELDS the name should
    // match, and carries the drop list for the system conditions it replaces.
    const confirm = { kind: 'term', name: 'Contoso', drop: [[1]], choices: [] };
    expect(toAppliedChoice(confirm, { name: 'Company contains “Contoso”', fields: ['companyName'] }))
      .toEqual({ kind: 'term', term: 'Contoso', fields: ['companyName'], drop: [[1]] });
  });

  it('is null when nothing was picked', () => {
    expect(toAppliedChoice({ kind: 'value', path: [0] }, null)).toBeNull();
  });
});

describe('isHelp', () => {
  it.each(['help', 'HELP', ' help ', '?', 'hulp'])('treats %j as a request for the examples', (t) => {
    expect(isHelp(t)).toBe(true);
  });

  it.each(['help me find guest accounts', 'who needs help', 'helpdesk group members'])('treats %j as a real question', (t) => {
    // A question that merely CONTAINS "help" must be answered, not deflected.
    expect(isHelp(t)).toBe(false);
  });
});

describe('defaultReportLink', () => {
  it('builds a fragment link against the configured base url', () => {
    expect(defaultReportLink('abc', 'https://ia.example')).toBe('https://ia.example/#bot-answer:abc');
  });

  it('does not double the slash when the base url has a trailing one', () => {
    expect(defaultReportLink('abc', 'https://ia.example///')).toBe('https://ia.example/#bot-answer:abc');
  });

  it('escapes the id instead of interpolating it raw', () => {
    expect(defaultReportLink('a b/c', 'https://ia.example')).toBe('https://ia.example/#bot-answer:a%20b%2Fc');
  });

  it('returns null when no base url is configured, so no broken link is shown', () => {
    expect(defaultReportLink('abc', undefined)).toBeNull();
    expect(defaultReportLink('abc', '')).toBeNull();
  });
});
