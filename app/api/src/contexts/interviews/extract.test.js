// Extraction with the model mocked: what is asked, what survives the checks,
// who the claims are matched to, and the status the interview ends in.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./store.js', () => ({
  loadForExtraction: vi.fn(), setExtraction: vi.fn(), keptClaims: vi.fn(),
  deleteProposedModelClaims: vi.fn(), insertClaims: vi.fn(),
}));
const store = await import('./store.js');
const {
  splitTranscript, checkReply, askPart, dedupeClaims, runMessage, extractInterview, startExtraction, chatTimeoutMs, MAX_PARTS, PART_CHARS, DEFAULT_TIMEOUT_MS,
} = await import('./extract.js');
const { foldForQuote } = await import('./claims.js');
const { LOCAL_SQL, SURNAME_SQL } = await import('./subjects.js');

const ANNA = 'aaaaaaaa-0000-4000-8000-000000000001';
const PIET = 'aaaaaaaa-0000-4000-8000-000000000002';
const YARA = 'aaaaaaaa-0000-4000-8000-000000000004';

const TRANSCRIPT = [
  'Interviewer: Who owns the planner?',
  'Anna Voorbeeld: Yes, I am the owner of this app, but it is mostly Piet who does the day-to-day.',
  'Anna Voorbeeld: Yara Testpersoon is my backup when I am away.',
  'Anna Voorbeeld: It holds the shift schedules of about 400 nurses.',
].join('\n');

const INTERVIEW = {
  id: 'iv-1', contextId: 'ctx-1', contextName: 'Planner', contextCategory: 'LogicalApplication',
  principalId: ANNA, identityId: null, intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01', transcript: TRANSCRIPT,
};

const REPLY = {
  claims: [
    { kind: 'role', subject: 'interviewee', relation: 'owner', value: 'owner of the planner', quote: 'Yes, I am the owner of this app', confidence: 0.9 },
    { kind: 'role', subject: 'Piet', relation: 'dayToDay', value: 'does the day-to-day', quote: 'it is mostly Piet who does the day-to-day' },
    { kind: 'role', subject: 'Yara Testpersoon', relation: 'delegate', value: 'backup', quote: 'Yara Testpersoon is my backup' },
    { kind: 'property', attribute: 'users', value: 'about 400 nurses', quote: 'shift schedules of about 400 nurses' },
    { kind: 'description', value: 'Schedules nurses', quote: 'It schedules every nurse in the region' },
    { kind: 'role', value: 'nobody', quote: 'Who owns the planner?' },
  ],
};

// Answers the directory lookup with Yara and the context's own people with Piet.
function fakeDb() {
  const inTx = [];
  return {
    inTx,
    query: async (sql) => (sql === LOCAL_SQL
      ? { rows: [{ id: PIET, displayName: 'Piet Jansen', holderCol: 'principalId' }] }
      : { rows: [{ id: YARA, displayName: 'Yara Testpersoon', email: null, upn: null, employeeId: null, externalId: null, principalType: 'User' }] }),
    tx: async (fn) => fn({ query: async (...a) => { inTx.push(a); return { rows: [] }; } }),
  };
}

const answer = (reply) => async () => ({ content: typeof reply === 'string' ? reply : JSON.stringify(reply), model: 'test-model' });

beforeEach(() => {
  for (const f of Object.values(store)) f.mockReset();
  store.loadForExtraction.mockResolvedValue(INTERVIEW);
  store.keptClaims.mockResolvedValue([]);
});

describe('splitTranscript', () => {
  it('cuts on line breaks and keeps every part within the size', () => {
    expect(splitTranscript('aaa\nbbb\ncc', 7)).toEqual(['aaa\nbbb', 'cc']);
    expect(splitTranscript('aaa\nbbb', 7)).toEqual(['aaa\nbbb']);
  });

  it('cuts a line longer than a part where it must, and drops an empty tail', () => {
    expect(splitTranscript('aa\nbbbbbbbbbb\n\n', 4)).toEqual(['aa', 'bbbb', 'bbbb', 'bb\n\n']);
    expect(splitTranscript('aaaa\n\n', 4)).toEqual(['aaaa']);
    expect(splitTranscript('x'.repeat(PART_CHARS + 1)).map(p => p.length)).toEqual([PART_CHARS, 1]);
  });
});

describe('checkReply', () => {
  const folded = foldForQuote(TRANSCRIPT);
  it('keeps the checked claims and counts what it dropped, and why', () => {
    const r = checkReply(REPLY, folded);
    expect(r.ok).toBe(true);
    expect(r.claims.map(c => c.claimKind)).toEqual(['role', 'role', 'role', 'property']);
    expect(r.dropped).toEqual({ invalid: 1, quote: 1, fields: { subject: 1, quote: 1 } });
    expect(r.repaired).toBe(0);
  });

  it('keeps what a small model left incomplete where that needs no guess, and counts it', () => {
    const r = checkReply({ claims: [
      { kind: 'property', value: 'about 400 nurses', quote: 'shift schedules of about 400 nurses' },
      { kind: 'roleHistory', subject: 'Piet', quote: 'it is mostly Piet who does the day-to-day' },
      { kind: 'role', subject: 'Yara Testpersoon', value: 'backup', quote: 'yara testpersoon is my BACKUP' },
      { kind: 'fact', value: 'x', quote: 'Who owns the planner?' },
    ] }, folded);
    expect(r.claims.map(c => [c.claimKind, c.value, c.quote])).toEqual([
      ['description', 'about 400 nurses', 'shift schedules of about 400 nurses'],
      ['roleHistory', 'it is mostly Piet who does the day-to-day', 'it is mostly Piet who does the day-to-day'],
      ['role', 'backup', 'Yara Testpersoon is my backup'],
    ]);
    expect(r.repaired).toBe(2);
    expect(r.dropped).toEqual({ invalid: 1, quote: 0, fields: { kind: 1 } });
  });

  it('refuses anything that is not a claims list', () => {
    for (const bad of [null, [], { claims: 'x' }, 'text']) expect(checkReply(bad, folded).ok).toBe(false);
  });
});

describe('askPart', () => {
  const folded = foldForQuote(TRANSCRIPT);
  const messages = [{ role: 'user', content: 'q' }];

  it('asks once more, with the reason, when the reply is not JSON', async () => {
    const ask = vi.fn().mockResolvedValueOnce({ content: 'Sure! Here are the claims', model: 'm' }).mockResolvedValueOnce({ content: '{"claims":[]}', model: 'm' });
    const r = await askPart(messages, folded, { ask });
    expect(r).toEqual({ ok: true, claims: [], dropped: { invalid: 0, quote: 0, fields: {} }, repaired: 0, model: 'm' });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1][0].slice(1)).toEqual([
      { role: 'assistant', content: 'Sure! Here are the claims' },
      { role: 'user', content: 'The reply must be one JSON object with a "claims" list. Reply again with the whole JSON.' },
    ]);
  });

  it('gives up after the repair round', async () => {
    const ask = vi.fn().mockResolvedValue({ content: '{"items":[]}' });
    await expect(askPart(messages, folded, { ask })).rejects.toThrow(/could not be read twice/);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('does not wait past its time budget', async () => {
    await expect(askPart(messages, folded, { ask: () => new Promise(() => {}), timeoutMs: 5 })).rejects.toThrow('no answer within 5 ms');
  });
});

describe('chatTimeoutMs', () => {
  it("takes the interview setting, else the report model's, else fifteen minutes", () => {
    expect(chatTimeoutMs({ INTERVIEW_LLM_TIMEOUT_MS: '60000', NL_REPORTS_LLM_TIMEOUT_MS: '900000' })).toBe(60_000);
    expect(chatTimeoutMs({ NL_REPORTS_LLM_TIMEOUT_MS: '600000' })).toBe(600_000);
    expect(chatTimeoutMs({})).toBe(DEFAULT_TIMEOUT_MS);
    expect(DEFAULT_TIMEOUT_MS).toBe(900_000);
  });

  it('skips a setting that is not a positive number', () => {
    expect(chatTimeoutMs({ INTERVIEW_LLM_TIMEOUT_MS: 'soon', NL_REPORTS_LLM_TIMEOUT_MS: '120000' })).toBe(120_000);
    expect(chatTimeoutMs({ INTERVIEW_LLM_TIMEOUT_MS: '0', NL_REPORTS_LLM_TIMEOUT_MS: '-5' })).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe('dedupeClaims', () => {
  const c = (value, over = {}) => ({ claimKind: 'property', subjectName: null, attribute: 'users', value, ...over });
  it('drops repeats (case and spacing aside) and anything already kept', () => {
    const out = dedupeClaims([c('400 nurses'), c('400  Nurses'), c('vendor x', { attribute: 'vendor' }), c('decided')], [c('decided')]);
    expect(out.map(x => x.value)).toEqual(['400 nurses', 'vendor x']);
  });
});

describe('runMessage', () => {
  it('says what was not read and what was left out, in the singular and plural', () => {
    expect(runMessage({ partsRead: 40, partsTotal: 41, dropped: { quote: 1, invalid: 2 } }))
      .toBe('Only the first 40 of 41 parts of the transcript were read. 1 claim was left out because the quote is not in the transcript. 2 incomplete claims were left out.');
    expect(runMessage({ partsRead: 1, partsTotal: 1, dropped: { quote: 1, invalid: 3, fields: { subject: 2, kind: 1, quote: 1 } }, repaired: 1 }))
      .toBe('1 claim was left out because the quote is not in the transcript. 3 incomplete claims were left out (2 without the person, 1 of an unknown kind). 1 claim had a field filled in from the quote — check it.');
    expect(runMessage({ partsRead: 1, partsTotal: 1, dropped: { quote: 0, invalid: 1, fields: { value: 1 } }, repaired: 2 }))
      .toBe('1 incomplete claim was left out (1 without a value). 2 claims had fields filled in from the quote — check them.');
    expect(runMessage({ partsRead: 1, partsTotal: 1, dropped: { quote: 0, invalid: 0 } })).toBeNull();
  });
});

describe('extractInterview', () => {
  it('without a model: stores notConfigured and asks nothing', async () => {
    const ask = vi.fn();
    const r = await extractInterview('iv-1', { db: fakeDb(), ask, enabled: () => false });
    expect(r.status).toBe('notConfigured');
    expect(ask).not.toHaveBeenCalled();
    expect(store.setExtraction).toHaveBeenCalledWith(expect.anything(), 'iv-1', { status: 'notConfigured', message: expect.stringMatching(/Add claims by hand/) });
  });

  it('owner + day-to-day + backup: the right suggestions, matched people, one transaction, status done', async () => {
    const db = fakeDb();
    const r = await extractInterview('iv-1', { db, ask: answer(REPLY), enabled: () => true });
    expect(r).toEqual({ status: 'done', claims: 4, message: '1 claim was left out because the quote is not in the transcript. 1 incomplete claim was left out (1 without the person).' });
    const [client, scope, claims] = store.insertClaims.mock.calls[0];
    expect(scope).toEqual({ interviewId: 'iv-1', contextId: 'ctx-1', proposedBy: 'model' });
    expect(claims.map(c => [c.claimKind, c.principalId, c.subjectMatch, c.roleSuggestion])).toEqual([
      ['role', ANNA, 'interviewee', 'Accountable'],
      ['role', PIET, 'firstName', 'Responsible'],
      ['role', YARA, 'name', 'Responsible'],
      ['property', null, null, null],
    ]);
    expect(store.deleteProposedModelClaims).toHaveBeenCalledWith(client, 'iv-1');
    expect(store.setExtraction.mock.calls.map(c => c[2])).toEqual([
      { status: 'running', started: true },
      { status: 'done', message: r.message, model: 'test-model' },
    ]);
  });

  it('a name the model cut short: matched by the full name in its quote, flagged fuzzy, Responsible suggested', async () => {
    const transcript = 'Anna Voorbeeld: Piet de Vries does most of the day-to-day work there.';
    store.loadForExtraction.mockResolvedValue({ ...INTERVIEW, transcript });
    const DE_VRIES = 'cccccccc-0000-4000-8000-000000000006';
    const db = {
      query: async (sql, params) => {
        if (sql === LOCAL_SQL || sql === SURNAME_SQL) return { rows: [] };
        const asked = params.flat().map(v => String(v).toLowerCase());
        return { rows: asked.includes('piet de vries') ? [{ id: DE_VRIES, displayName: 'Piet de Vries', email: null, upn: null, employeeId: null, externalId: null, principalType: 'User' }] : [] };
      },
      tx: async (fn) => fn({ query: async () => ({ rows: [] }) }),
    };
    const reply = { claims: [{ kind: 'role', subject: 'Vries', relation: 'dayToDay', value: 'does the day-to-day', quote: 'Piet de Vries does most of the day-to-day work there' }] };
    await extractInterview('iv-1', { db, ask: answer(reply), enabled: () => true });
    expect(store.insertClaims.mock.calls[0][2].map(c => [c.subjectName, c.principalId, c.subjectMatch, c.roleSuggestion]))
      .toEqual([['Piet de Vries', DE_VRIES, 'fuzzy', 'Responsible']]);
  });

  it('a re-run does not propose again what was already decided', async () => {
    store.keptClaims.mockResolvedValue([{ claimKind: 'property', subjectName: null, attribute: 'users', value: 'About 400 nurses' }]);
    await extractInterview('iv-1', { db: fakeDb(), ask: answer(REPLY), enabled: () => true });
    expect(store.insertClaims.mock.calls[0][2].map(c => c.claimKind)).toEqual(['role', 'role', 'role']);
  });

  it('a model that fails leaves the interview failed with the reason, and writes no claims', async () => {
    const r = await extractInterview('iv-1', { db: fakeDb(), ask: async () => { throw new Error('connection refused'); }, enabled: () => true });
    expect(r).toEqual({ status: 'failed', claims: 0, message: 'Extraction failed: connection refused' });
    expect(store.insertClaims).not.toHaveBeenCalled();
    expect(store.setExtraction).toHaveBeenLastCalledWith(expect.anything(), 'iv-1', { status: 'failed', message: 'Extraction failed: connection refused' });
  });

  it(`reads at most ${MAX_PARTS} parts and says so`, async () => {
    store.loadForExtraction.mockResolvedValue({ ...INTERVIEW, transcript: Array.from({ length: MAX_PARTS + 1 }, () => 'y'.repeat(PART_CHARS)).join('\n') });
    const ask = vi.fn(answer({ claims: [] }));
    const r = await extractInterview('iv-1', { db: fakeDb(), ask, enabled: () => true });
    expect(ask).toHaveBeenCalledTimes(MAX_PARTS);
    expect(ask.mock.calls[0][0][1].content).toMatch(`Transcript, part 1 of ${MAX_PARTS}:`);
    expect(r.message).toBe(`Only the first ${MAX_PARTS} of ${MAX_PARTS + 1} parts of the transcript were read.`);
  });

  it('an interview that is gone is reported missing', async () => {
    store.loadForExtraction.mockResolvedValue(null);
    expect((await extractInterview('iv-x', { db: fakeDb(), enabled: () => true })).status).toBe('missing');
  });
});

describe('startExtraction', () => {
  it('never throws, even when storing the failure fails', async () => {
    store.loadForExtraction.mockRejectedValue(new Error('db down'));
    await expect(startExtraction('iv-1', { db: fakeDb(), enabled: () => true })).resolves.toEqual({ status: 'failed', claims: 0, message: null });
  });
});
