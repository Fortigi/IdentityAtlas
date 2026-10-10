import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../nlreports/llm.js', () => ({ chat: vi.fn(), warm: vi.fn(), modelState: vi.fn() }));
vi.mock('../../nlreports/settings.js', () => ({ getReportModel: vi.fn(async () => 'test-model') }));
vi.mock('../../featureFlags.js', async (importOriginal) => ({ ...(await importOriginal()), isFeatureEnabled: vi.fn(async () => true) }));

import { chat, warm, modelState } from '../../nlreports/llm.js';
import { getReportModel } from '../../nlreports/settings.js';
import { isFeatureEnabled } from '../../featureFlags.js';
import {
  askModel, checkReply, modelReachable, propose, repairMessage, warmAtStartup, withTimeout, CHAT_TIMEOUT_MS,
} from './service.js';
import { buildPrompt, RESPONSE_SCHEMA } from './prompt.js';
import { heuristicProposal } from './heuristic.js';

const columns = [
  { name: 'AssetId', index: 0, nonEmpty: 10, distinct: 10, uniqueness: 1, shape: 'text', samples: ['A-1'] },
  { name: 'AssetName', index: 1, nonEmpty: 10, distinct: 10, uniqueness: 1, shape: 'text', samples: ['Lift'] },
  { name: 'KeeperEmail', index: 2, nonEmpty: 10, distinct: 3, uniqueness: 0.3, shape: 'email', samples: ['k@contoso.com'] },
];
const input = { fileName: 'Assets.xlsx', columns };

const goodReply = {
  recipe: {
    version: 1,
    entities: [
      { type: 'Asset', keyColumn: 'AssetId', nameColumn: 'AssetName' },
      { type: 'Keeper', nameColumn: 'KeeperEmail', attributes: [{ column: 'KeeperEmail', name: 'email' }] },
    ],
    relations: [{ predicate: 'keeper', from: 'Asset', to: 'Keeper' }],
  },
  linkRules: [{ entityType: 'Keeper', targetType: 'Principal', signals: [{ attribute: 'email', targetField: 'email', type: 'exact', weight: 90 }] }],
  notes: ['  Keeper is a person.  ', 7, ''],
};
const badReply = { ...goodReply, recipe: { ...goodReply.recipe, entities: [{ type: 'Asset', nameColumn: 'Nope' }], relations: [] }, linkRules: [] };
const answer = (obj, totalMs = 1000) => ({ content: typeof obj === 'string' ? obj : JSON.stringify(obj), timing: { totalMs } });

beforeEach(() => {
  chat.mockReset();
  warm.mockReset();
  warm.mockResolvedValue({ model: 'test-model', ms: 1, restored: true });
  modelState.mockReset();
  modelState.mockResolvedValue('ready');
  getReportModel.mockResolvedValue('test-model');
  isFeatureEnabled.mockResolvedValue(true);
  process.env.NL_REPORTS_LLM_URL = 'http://report-generator:8080';
});

describe('propose — the five paths', () => {
  it('model valid: returns the model\'s normalised proposal with its notes', async () => {
    chat.mockResolvedValueOnce(answer(goodReply, 4321));
    const r = await propose(input);
    expect(r.origin).toBe('model');
    expect(r.recipe.entities[1]).toEqual({ type: 'Keeper', nameColumn: 'KeeperEmail', keyColumn: 'KeeperEmail', attributes: [{ column: 'KeeperEmail', name: 'email' }] });
    expect(r.linkRules[0].threshold).toBe(50);
    expect(r.notes).toEqual(['Keeper is a person.']);
    expect(r.timing).toMatchObject({ model: true, rounds: 1, llm: { totalMs: 4321 } });
    expect(chat).toHaveBeenCalledTimes(1);
    const { model, messages, schema } = chat.mock.calls[0][0];
    expect(model).toBe('test-model');
    expect(schema).toBe(RESPONSE_SCHEMA);
    expect(messages[0]).toEqual({ role: 'system', content: buildPrompt() });
    expect(messages[1].content).toMatch(/^File: "Assets.xlsx"\nColumns:\n- "AssetId" \| text/);
  });

  it('model invalid, then repaired: sends the errors back once and uses the second answer', async () => {
    chat.mockResolvedValueOnce(answer(badReply)).mockResolvedValueOnce(answer(goodReply, 77));
    const r = await propose(input);
    expect(r.origin).toBe('model');
    expect(r.timing).toMatchObject({ rounds: 2, llm: { totalMs: 77 } });
    const messages = chat.mock.calls[1][0].messages;
    expect(messages).toHaveLength(4);
    expect(messages[2]).toEqual({ role: 'assistant', content: JSON.stringify(badReply) });
    expect(messages[3].role).toBe('user');
    expect(messages[3].content).toContain('- Entity "Asset" nameColumn refers to column "Nope", which the source does not have.');
  });

  it('model invalid twice: falls back to the heuristic and says why', async () => {
    chat.mockResolvedValueOnce(answer('not json')).mockResolvedValueOnce(answer(badReply));
    const r = await propose(input);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1][0].messages[3].content).toContain('- The reply was not valid JSON.');
    expect(r.origin).toBe('heuristic');
    expect(r.recipe).toEqual(heuristicProposal(input).recipe);
    expect(r.notes[0]).toBe('The local model\'s proposal could not be used: its answer did not fit the list after one correction (Entity "Asset" nameColumn refers to column "Nope", which the source does not have.). This proposal comes from the column names and values.');
    expect(r.notes.slice(1)).toEqual(heuristicProposal(input).notes);
    expect(r.timing).toMatchObject({ model: true, rounds: 2 });
  });

  it('probed values: the data decides (origin data), the model is never asked or even checked', async () => {
    const probes = { KeeperEmail: { values: 3, people: 1, resources: 0, orgEntities: 0, orgEntityTypes: [] } };
    const r = await propose({ ...input, probes });
    expect(r.origin).toBe('data');
    expect(r.timing.model).toBe(false);
    expect(r.recipe).toEqual(heuristicProposal({ ...input, probes }).recipe);
    expect(r.linkRules).toEqual(heuristicProposal({ ...input, probes }).linkRules);
    expect(chat).not.toHaveBeenCalled();
    expect(modelState).not.toHaveBeenCalled();
  });

  it('model unreachable: the heuristic, without asking the model', async () => {
    modelState.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const r = await propose(input);
    expect(r.origin).toBe('heuristic');
    expect(r.timing.model).toBe(false);
    expect(r.notes).toEqual(heuristicProposal(input).notes);
    expect(chat).not.toHaveBeenCalled();
  });

  it('no model server configured: the heuristic without calling the model at all', async () => {
    delete process.env.NL_REPORTS_LLM_URL;
    const r = await propose(input);
    expect(r).toMatchObject({ origin: 'heuristic', recipe: heuristicProposal(input).recipe, linkRules: heuristicProposal(input).linkRules });
    expect(modelState).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(warm).not.toHaveBeenCalled();
  });
});

describe('propose — failures during the call', () => {
  it('a server error falls back with a generic reason; the server text stays in the log', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    chat.mockRejectedValueOnce(new Error('LLM server returned 500: secret stack'));
    const r = await propose(input);
    expect(r.origin).toBe('heuristic');
    expect(r.notes[0]).toBe('The local model\'s proposal could not be used: the local model server failed. This proposal comes from the column names and values.');
    expect(r.notes.join(' ')).not.toContain('secret');
    expect(warnSpy).toHaveBeenCalledWith('org-truth propose: model call failed —', 'LLM server returned 500: secret stack');
    warnSpy.mockRestore();
  });

  it('a model slower than the time box falls back, naming the limit', async () => {
    chat.mockReturnValueOnce(new Promise(() => {}));
    const r = await propose(input, { timeoutMs: 5, warmWaitMs: 5 });
    expect(r.origin).toBe('heuristic');
    expect(r.notes[0]).toContain('the local model did not answer within 0 seconds');
  });

  it('asks even when the warm-up fails or hangs, and without a model name when settings fail', async () => {
    warm.mockRejectedValueOnce(new Error('no slot'));
    getReportModel.mockRejectedValue(new Error('db down'));
    chat.mockResolvedValueOnce(answer(goodReply));
    expect((await propose(input)).origin).toBe('model');
    expect(chat.mock.calls[0][0].model).toBeUndefined();

    getReportModel.mockResolvedValue('test-model');
    let release;
    warm.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    chat.mockResolvedValueOnce(answer(goodReply));
    expect((await askModel({ fileName: 'a', columns }, { warmWaitMs: 5 })).ok).toBe(true);
    // Let the shared warm-up finish, so later tests do not wait on it.
    release({ model: 'test-model', ms: 1, restored: true });
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('throws only for a profile the heuristic cannot work with', async () => {
    await expect(propose({ columns: [] })).rejects.toThrow('no named columns');
    await expect(propose()).rejects.toThrow('no named columns');
  });

  it('time-boxes the chat call at 20 seconds by default', () => {
    expect(CHAT_TIMEOUT_MS).toBe(20_000);
  });
});

describe('checkReply', () => {
  const names = columns.map(c => c.name);

  it('refuses anything that is not one object', () => {
    for (const reply of [null, 'x', [goodReply]]) {
      expect(checkReply(reply, names)).toEqual({ ok: false, errors: ['The reply must be one JSON object with "recipe", "linkRules" and "notes".'] });
    }
  });

  it('reports link-rule errors against the recipe', () => {
    const reply = { ...goodReply, linkRules: [{ entityType: 'Ghost', targetType: 'Principal', signals: [{ attribute: 'email', targetField: 'email', type: 'exact', weight: 90 }] }] };
    const r = checkReply(reply, names);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(['Link rule 1 is for entity type "Ghost", which the recipe does not define.']);
  });

  it('accepts missing link rules and notes, and bounds the notes', () => {
    const r = checkReply({ recipe: goodReply.recipe }, names);
    expect(r).toMatchObject({ ok: true, linkRules: [], notes: [] });
    const many = checkReply({ ...goodReply, notes: Array.from({ length: 12 }, () => 'n'.repeat(300)) }, names);
    expect(many.notes).toHaveLength(8);
    expect(many.notes[0]).toHaveLength(200);
  });
});

describe('helpers', () => {
  it('repairMessage lists at most ten errors', () => {
    const msg = repairMessage(Array.from({ length: 12 }, (_, i) => `E${i}.`));
    expect(msg.split('\n')).toEqual(['Your reply cannot be used:', ...Array.from({ length: 10 }, (_, i) => `- E${i}.`), 'Reply again with the whole corrected JSON.']);
  });

  it('withTimeout passes a result through and rejects a slow promise with the message', async () => {
    await expect(withTimeout(Promise.resolve(3), 50, 'slow')).resolves.toBe(3);
    await expect(withTimeout(new Promise(() => {}), 1, 'too slow')).rejects.toThrow('too slow');
  });

  it('modelReachable needs a configured URL and an answering server', async () => {
    expect(await modelReachable()).toBe(true);
    modelState.mockRejectedValueOnce(new Error('down'));
    expect(await modelReachable()).toBe(false);
    delete process.env.NL_REPORTS_LLM_URL;
    expect(await modelReachable()).toBe(false);
  });
});

describe('warm-up at API start', () => {
  it('prepares this prompt when orgTruth is on and a model server is configured', async () => {
    expect(await warmAtStartup({ delayMs: 0 })).toBe('ready');
    expect(warm).toHaveBeenCalledWith('test-model', buildPrompt(), '');
    expect(isFeatureEnabled).toHaveBeenCalledWith('orgTruth');
  });

  it('does nothing while the feature is off', async () => {
    isFeatureEnabled.mockResolvedValueOnce(false);
    expect(await warmAtStartup({ delayMs: 0 })).toBe('skipped');
    expect(warm).not.toHaveBeenCalled();
  });
});
