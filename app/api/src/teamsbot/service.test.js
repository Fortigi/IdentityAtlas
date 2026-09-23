import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/connection.js');
// Discovered attributes need a live database to read the JSON keys; the bot's
// own tests are about what it does with a definition, not what fields exist.
vi.mock('../nlreports/extFields.js', () => ({ loadExtFields: vi.fn(async () => ({})) }));
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

import { answerMessage, withDeadline, matchChoice, toAppliedChoice, isHelp, defaultReportLink, TIMED_OUT, DEADLINE_MS } from './service.js';
import { clearPending } from './state.js';
import { EN, NL } from './text.js';
import { CALLER_SENTINEL, PREVIOUS_SENTINEL } from '../nlreports/spec.js';
import { sentinelsIn, substituteValues } from '../nlreports/sentinels.js';

// What the real interpret() does with the placeholders it is handed: resolve
// them in the definition and say which it saw. Mocks that skip this would let
// the bot pass every test below without ever supplying the substitutions.
const asPipeline = (spec) => vi.fn(async ({ substitutions } = {}) => ({
  kind: 'report',
  spec: substituteValues(structuredClone(spec), substitutions ?? new Map()),
  timing: { totalMs: 49_000 },
  substituted: sentinelsIn(spec, substitutions ?? new Map()),
}));

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
    interpret: asPipeline(reportSpec),
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

    const { question, context, history } = d.interpret.mock.calls[0][0];
    expect(context).toContain(CALLER.displayName);
    expect(context).toContain(OID);
    expect(question).toBe('which of my direct reports are there?');
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
    expect(asked.outcome).toBe('confirm');
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

describe('following one answer up with another question', () => {
  // The thing a chat can do that the report builder cannot: "van welke groepen
  // ben ik owner?" and then "en zijn die onderdeel van een access package?",
  // where "die" is 27 groups that exist only in the answer above.

  const OWNED = runResult({
    columns: [{ key: 'owns.names', label: 'Owner of' }],
    rows: [{
      'owns.names': 'ASML, Bestuur',
      _entity: { kind: 'user', id: OID },
      _links: {
        'owns.names': [
          { id: 'g1', name: 'ASML', kind: 'resource' },
          { id: 'g2', name: 'Bestuur', kind: 'resource' },
        ],
      },
    }],
  });

  const referringSpec = {
    entity: 'resource', match: 'all',
    conditions: [{ type: 'field', field: 'id', op: 'in', value: PREVIOUS_SENTINEL }],
    columns: ['displayName'],
  };

  /** Ask once so there is an answer to refer back to, then ask again. */
  async function askTwice({ second = referringSpec, first = OWNED } = {}) {
    const d = deps({ runSpec: vi.fn(async () => first) });
    await answerMessage(msg({ text: 'van welke groepen ben ik owner?' }), d);

    const follow = deps({
      interpret: asPipeline(second),
      runSpec: vi.fn(async () => runResult()),
    });
    await answerMessage(msg({ text: 'en zijn die onderdeel van een access package?' }), follow);
    return follow;
  }

  it('tells the model what the previous answer was about', async () => {
    const follow = await askTwice();
    const offered = follow.interpret.mock.calls[0][0].context;
    expect(offered).toContain('2');
    expect(offered).toContain(PREVIOUS_SENTINEL);
  });

  it('runs the follow-up against the records the caller was just shown', async () => {
    const follow = await askTwice();
    expect(follow.runSpec.mock.calls[0][0].conditions[0].value).toEqual(['g1', 'g2']);
  });

  it('says nothing about a previous answer on the first question of a chat', async () => {
    const d = deps();
    await answerMessage(msg(), d);
    expect(d.interpret.mock.calls[0][0].context ?? '').not.toContain(PREVIOUS_SENTINEL);
  });

  it('leaves a question that did not refer back completely alone', async () => {
    // The expensive failure is the opposite of a missed follow-up: an
    // unrelated question silently narrowed to the last answer's records.
    const standalone = {
      entity: 'resource', match: 'all',
      conditions: [{ type: 'field', field: 'displayName', op: 'eq', value: 'Finance' }],
      columns: ['displayName'],
    };
    const follow = await askTwice({ second: standalone });
    expect(follow.runSpec.mock.calls[0][0]).toEqual(standalone);
  });

  it('offers the NEW answer to the question after it', async () => {
    const d = deps({ runSpec: vi.fn(async () => OWNED) });
    await answerMessage(msg(), d);
    await answerMessage(msg(), d);
    expect(d.interpret.mock.calls[1][0].context).toContain(PREVIOUS_SENTINEL);
  });

  it('carries nothing forward from an answer that matched nothing', async () => {
    // Nothing was put in front of the caller, so there is nothing to refer to.
    const d = deps({ runSpec: vi.fn(async () => runResult({ rows: [] })) });
    await answerMessage(msg(), d);
    await answerMessage(msg(), d);
    expect(d.interpret.mock.calls[1][0].context ?? '').not.toContain(PREVIOUS_SENTINEL);
  });

  it('keeps the answer from one chat out of another chat', async () => {
    const d = deps({ runSpec: vi.fn(async () => OWNED) });
    await answerMessage(msg({ conversationId: 'conv-a' }), d);
    await answerMessage(msg({ conversationId: 'conv-b' }), d);
    expect(d.interpret.mock.calls[1][0].context ?? '').not.toContain(PREVIOUS_SENTINEL);
  });

  it('narrows to the previous answer even when the model does not ask it to', async () => {
    // The real failure, reproduced. Asked "Welke van deze groepen zitten in
    // access packages?" the model produced exactly this — the businessRoles
    // relation, which is the hard half, and no narrowing at all — so the bot
    // reported on all 104 groups in the directory instead of the caller's 2.
    const modelSpec = {
      entity: 'group', match: 'all', columns: ['displayName', 'id'],
      conditions: [{ type: 'relation', relation: 'businessRoles', quantifier: 'some', match: 'all', conditions: [] }],
    };

    const d = deps({ runSpec: vi.fn(async () => OWNED) });
    await answerMessage(msg({ text: 'van welke groepen ben ik owner?' }), d);

    const follow = deps({
      interpret: vi.fn(async () => ({ kind: 'report', spec: structuredClone(modelSpec), timing: {} })),
      runSpec: vi.fn(async () => runResult()),
    });
    const out = await answerMessage(msg({ text: 'Welke van deze groepen zitten in access packages?' }), follow);

    const ran = follow.runSpec.mock.calls[0][0];
    expect(ran.conditions).toContainEqual({ type: 'field', field: 'id', op: 'in', value: ['g1', 'g2'] });
    // And the model's own condition is still there — narrowed, not replaced.
    expect(ran.conditions[0]).toEqual(modelSpec.conditions[0]);
    expect(text(out.attachment)).toContain(NL.followedUp(2));
  });

  it('says on the card that it answered about the previous records', async () => {
    // The same principle as the interpretation line above it. A caller who
    // asked "en zijn die …?" cannot otherwise tell whether "die" was
    // understood or quietly dropped — both come back as a tidy card.
    const d = deps({ runSpec: vi.fn(async () => OWNED) });
    await answerMessage(msg({ text: 'van welke groepen ben ik owner?' }), d);

    const follow = deps({
      interpret: asPipeline(referringSpec),
      runSpec: vi.fn(async () => runResult()),
    });
    const out = await answerMessage(msg({ text: 'en zijn die onderdeel van een access package?' }), follow);

    expect(text(out.attachment)).toContain(NL.followedUp(2));
  });

  it('says nothing of the kind when the question stood on its own', async () => {
    const d = deps();
    const out = await answerMessage(msg(), d);
    expect(text(out.attachment)).not.toContain('previous question');
    expect(text(out.attachment)).not.toContain('vorige vraag');
  });

  it('still substitutes the caller in the same definition', async () => {
    // @me and @previous are two passes over one definition; neither may eat
    // the other.
    const both = {
      entity: 'resource', match: 'all',
      conditions: [
        { type: 'field', field: 'id', op: 'in', value: PREVIOUS_SENTINEL },
        { type: 'relation', relation: 'owners', quantifier: 'some', match: 'all',
          conditions: [{ type: 'field', field: 'id', op: 'eq', value: CALLER_SENTINEL }] },
      ],
      columns: ['displayName'],
    };
    const follow = await askTwice({ second: both });
    const ran = follow.runSpec.mock.calls[0][0];
    expect(ran.conditions[0].value).toEqual(['g1', 'g2']);
    expect(ran.conditions[1].conditions[0].value).toBe(OID);
  });
});

describe('what the pipeline is told the caller asked', () => {
  // The bot knows things the model needs — who is asking, what the previous
  // answer listed. None of it is part of the QUESTION, and that distinction is
  // not cosmetic.
  //
  // While the context was glued in front of the question, the pipeline's
  // name-matching read the caller's own name out of it and treated it as a
  // name the caller had typed. "Van welke groepen ben ik owner?" came back as
  // Name contains "Wim" OR Name contains "Heijkant" — a directory-wide report
  // about everyone with a similar name, offered as the answer to a question
  // about the caller's own groups.

  it('hands the caller over as context, and the question untouched', async () => {
    const d = deps();
    await answerMessage(msg({ text: 'van welke groepen ben ik owner?' }), d);

    const call = d.interpret.mock.calls[0][0];
    expect(call.question).toBe('van welke groepen ben ik owner?');
    expect(call.context).toContain('Wim van den Heijkant');
  });

  it('keeps every part of the caller identity out of the question', async () => {
    // The regression this exists for. Any fragment of the caller's name
    // reaching the question is enough to be matched against the directory.
    const d = deps();
    await answerMessage(msg({ text: 'van welke groepen ben ik owner?' }), d);

    const { question } = d.interpret.mock.calls[0][0];
    for (const part of ['Wim', 'Heijkant', CALLER.email, OID]) {
      expect(question, `"${part}" leaked into the question`).not.toContain(part);
    }
  });

  it('repeats no context once a clarification is under way', async () => {
    // The first turn's context is already in the history a clarification
    // carries, so handing it over again would state everything twice.
    const clarifying = deps({
      interpret: vi.fn(async () => ({ kind: 'clarify', question: 'Which Finance?', options: [], raw: '{}' })),
    });
    await answerMessage(msg(), clarifying);

    const answering = deps();
    await answerMessage(msg({ text: 'the second one' }), answering);
    expect(answering.interpret.mock.calls[0][0].context).toBe('');
  });

  it('still carries the caller into the remembered history', async () => {
    // Not repeating it only works because the history already holds it.
    const clarifying = deps({
      interpret: vi.fn(async () => ({ kind: 'clarify', question: 'Which Finance?', options: [], raw: '{}' })),
    });
    await answerMessage(msg(), clarifying);

    const answering = deps();
    await answerMessage(msg({ text: 'the second one' }), answering);
    const { history } = answering.interpret.mock.calls[0][0];
    expect(JSON.stringify(history)).toContain('Wim van den Heijkant');
  });
});

describe('the answer deadline', () => {
  it('leaves room for two full model rounds on the hardware this runs on', () => {
    // At ~2 tokens/second a question needing two 400-token definitions costs
    // ~480 s. At 420 s an ordinary question timed out by 14% and was reported
    // as a failure. If this ever drops back under 480 s, that returns.
    expect(DEADLINE_MS).toBeGreaterThanOrEqual(480_000);
  });

  it('stays below the model client’s own HTTP timeout', () => {
    // Past 900 s (NL_REPORTS_LLM_TIMEOUT_MS) the HTTP call gives up first and
    // the caller gets a connection error instead of the bot's own "that took
    // too long" card, which is the one reply that explains itself.
    expect(DEADLINE_MS).toBeLessThan(900_000);
  });

  it('tells the caller how long it actually waited', () => {
    // The card quotes the budget, so a deployment that tuned it does not
    // advertise a number it no longer uses.
    const seconds = String(Math.round(DEADLINE_MS / 1000));
    expect(EN.timeoutHint(seconds)).toContain(seconds);
    expect(NL.timeoutHint(seconds)).toContain(seconds);
  });
});

describe('what the log says about a slow answer', () => {
  it('records whether the model needed a second attempt', async () => {
    // On this hardware the model writes ~2 tokens/second, so a repair round
    // roughly doubles the wait. Without this line the only way to tell one
    // round from two was to divide elapsed time by the length of the stored
    // definition and read the ratio.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const d = deps({
        interpret: vi.fn(async () => ({
          kind: 'report', spec: structuredClone(reportSpec), timing: {}, repaired: true,
        })),
      });
      await answerMessage(msg(), d);
      expect(log.mock.calls.flat().join(' ')).toContain('repaired=true');
    } finally {
      log.mockRestore();
    }
  });

  it('says so plainly when it got there first time', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await answerMessage(msg(), deps());
      expect(log.mock.calls.flat().join(' ')).toContain('repaired=false');
    } finally {
      log.mockRestore();
    }
  });
});

describe('what the bot leaves in the conversation store', () => {
  // Since migration 071 the store is the evidence for "was the answer right",
  // not only "how long did it take". That needs what the model was told and
  // what it said, on every outcome that involved the model.
  it('records the surface, the context the model was given and its raw reply', async () => {
    const d = deps({
      interpret: vi.fn(async () => ({
        kind: 'report', spec: structuredClone(reportSpec), timing: { totalMs: 1 },
        context: 'The person asking this question is Wim', raw: '{"kind":"report"}', repaired: true, model: 'qwen3:4b',
      })),
    });
    await answerMessage(msg(), d);
    const row = d.log.mock.calls[0][0];
    expect(row.surface).toBe('teams');
    expect(row.context).toContain('Wim');
    expect(row.rawReply).toBe('{"kind":"report"}');
    expect(row.repaired).toBe(true);
    expect(row.model).toBe('qwen3:4b');
  });

  it('records them for a clarifying question too — that turn is the one worth reviewing', async () => {
    const d = deps({
      interpret: vi.fn(async () => ({ kind: 'clarify', question: 'Which Finance?', options: [], raw: '{"kind":"clarify"}', context: 'ctx', repaired: false })),
    });
    await answerMessage(msg(), d);
    const row = d.log.mock.calls[0][0];
    expect(row.rawReply).toBe('{"kind":"clarify"}');
    expect(row.context).toBe('ctx');
    expect(row.repaired).toBe(false);
  });

  it('records nulls, not the previous turn, when no model call was made', async () => {
    // Answering a "did you mean" applies the choice to the earlier definition
    // without asking the model. There is nothing it was told this turn.
    const d = deps({ runSpec: vi.fn(async () => runResult()) });
    const confirm = { kind: 'reference', path: [0], name: 'Fin', message: 'Did you mean?', choices: [{ name: 'Finance', id: 'g1' }] };
    const first = deps({ interpret: vi.fn(async () => ({ kind: 'confirm', confirm, spec: structuredClone(reportSpec), timing: {}, raw: 'r', context: 'c' })) });
    await answerMessage(msg({ text: 'members of Fin' }), first);
    await answerMessage(msg({ text: 'Finance' }), d);
    const row = d.log.mock.calls[0][0];
    expect(row.rawReply).toBe(null);
    expect(row.context).toBe(null);
    expect(row.repaired).toBe(null);
  });
});

describe('what the bot hands the pipeline to resolve', () => {
  // Since the placeholders are resolved inside interpret(), the bot's part is
  // to SUPPLY them. Every assertion above about a real id in the definition
  // that runs only holds because these maps reach the pipeline.
  it('supplies the caller as @me on every question', async () => {
    const d = deps();
    await answerMessage(msg(), d);
    const { substitutions } = d.interpret.mock.calls[0][0];
    expect(substitutions.get(CALLER_SENTINEL)).toBe(OID);
    expect(substitutions.has(PREVIOUS_SENTINEL)).toBe(false);
  });

  it('adds the previous answer as @previous once there is one', async () => {
    const d = deps({ runSpec: vi.fn(async () => ({
      ok: true, explanation: 'x', columns: [{ key: 'owns.names', label: 'Owner of' }], truncated: false, elapsedMs: 1,
      rows: [{ 'owns.names': 'ASML, Bestuur', _entity: { kind: 'user', id: OID },
        _links: { 'owns.names': [{ id: 'g1', name: 'ASML', kind: 'resource' }, { id: 'g2', name: 'Bestuur', kind: 'resource' }] } }],
    })) });
    await answerMessage(msg({ text: 'van welke groepen ben ik owner?' }), d);
    await answerMessage(msg({ text: 'en die?' }), d);
    const { substitutions } = d.interpret.mock.calls[1][0];
    expect(substitutions.get(CALLER_SENTINEL)).toBe(OID);
    expect(substitutions.get(PREVIOUS_SENTINEL)).toEqual(['g1', 'g2']);
  });

  it('no longer resolves anything itself — a definition the pipeline left alone stays as it is', async () => {
    // A mock that ignores the map stands in for a pipeline that was not given
    // one. The bot must not paper over that with a second substitution.
    const d = deps({ interpret: vi.fn(async () => ({ kind: 'report', spec: structuredClone(reportSpec), timing: {} })) });
    await answerMessage(msg(), d);
    expect(JSON.stringify(d.runSpec.mock.calls[0][0])).toContain(CALLER_SENTINEL);
  });
});
