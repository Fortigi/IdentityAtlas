import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
vi.mock('./model.js', () => ({ ask: vi.fn(), modelStatus: vi.fn() }));
vi.mock('./resolve.js', () => ({ resolveMentions: vi.fn(async () => new Map()) }));
vi.mock('./mentions.js', () => ({ renamedMentions: vi.fn(async () => new Map()) }));
vi.mock('./corroboration.js', () => ({ rescoreSource: vi.fn(async () => ({ scored: 1, corroborated: 1, contradicted: 0 })) }));
vi.mock('./findings.js', () => ({
  ruleFindings: vi.fn(() => [{ kind: 'question', category: 'unresolved-name', text: 'Wie?', related: {}, origin: 'rule' }]),
  modelFindings: vi.fn(() => []),
  directoryFindings: vi.fn(async () => []),
}));
vi.mock('./store.js', () => ({
  getRun: vi.fn(), getTranscript: vi.fn(), getPassages: vi.fn(), updateRun: vi.fn(async () => {}),
  isCancelRequested: vi.fn(async () => false), latestCache: vi.fn(async () => ({})),
  writeResults: vi.fn(async () => ({ mentions: 1, links: 0, claims: 1, evidence: 1, findings: 1 })),
}));

import { executeExtraction } from './run.js';
import { modelStatus } from './model.js';
import { getRun, getTranscript, getPassages, updateRun, isCancelRequested, latestCache, writeResults } from './store.js';
import { ruleFindings } from './findings.js';

const P = { id: 'p1', seq: 1, startChar: 0, text: 'Rob zit in het kernteam van Omada.' };
const scriptedAsk = async ({ user, check }) => {
  const reply = user.includes('mainly about') ? { topic: 'membership' }
    : user.includes('literal mention') ? { mentions: [{ text: 'Rob', type: 'person' }] }
      : user.includes('Extract atomic') ? { claims: [{ subject: 'Rob', predicate: 'memberOf', object: 'kernteam', modality: 'stated', quote: 'Rob zit in het kernteam' }] }
        : user.includes('ALONE') ? { verdict: 'supported' } : { findings: [] };
  return { ...check(reply), rounds: 1, timing: {} };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  getRun.mockResolvedValue({ id: 'r1', sourceId: 's1', details: { config: { mode: 'pipeline' } } });
  getTranscript.mockResolvedValue({ id: 's1', metadata: { language: 'nl' }, observedAt: '2026-10-11' });
  getPassages.mockResolvedValue([P]);
  modelStatus.mockResolvedValue({ configured: true, reachable: true, model: 'qwen3:4b' });
});

const lastUpdate = () => updateRun.mock.calls.at(-1)[1];

describe('executeExtraction', () => {
  it('runs the stages, writes once and completes with model, counts and per-stage stats', async () => {
    await executeExtraction('r1', { ask: scriptedAsk });
    expect(writeResults).toHaveBeenCalledTimes(1);
    const w = writeResults.mock.calls[0][1];
    expect(w.result.claims.map(c => c.subject)).toEqual(['Rob']);
    expect(w.findings).toHaveLength(1);
    expect(ruleFindings).toHaveBeenCalledWith(expect.objectContaining({ language: 'nl' }));
    const done = lastUpdate();
    expect(done).toMatchObject({ status: 'completed', step: 'completed', pct: 100 });
    expect(done.stats).toMatchObject({ model: 'qwen3:4b', mode: 'pipeline', passages: 1, claimsBySupport: { supported: 1 } });
    expect(done.stats.pipeline.perStage.claims.calls).toBe(1);
    expect(done.details.model).toBe('qwen3:4b');
    expect(Object.keys(done.details.cache).length).toBeGreaterThan(0);
    expect(updateRun.mock.calls.map(c => c[1].step).filter(Boolean)).toEqual(expect.arrayContaining(['stages', 'resolve', 'findings', 'write', 'completed']));
  });

  it('refuses to start without a reachable model, saying which', async () => {
    modelStatus.mockResolvedValue({ configured: false, reachable: false });
    await executeExtraction('r1', { ask: scriptedAsk });
    expect(lastUpdate()).toMatchObject({ status: 'failed', error: expect.stringContaining('No local model is configured') });
    modelStatus.mockResolvedValue({ configured: true, reachable: false, error: 'ECONNREFUSED' });
    await executeExtraction('r1', { ask: scriptedAsk });
    expect(lastUpdate().error).toContain('ECONNREFUSED');
    expect(writeResults).not.toHaveBeenCalled();
  });

  it('a cancelled run ends cancelled and keeps its cache for a resume', async () => {
    isCancelRequested.mockResolvedValueOnce(false).mockResolvedValue(true);
    getRun.mockResolvedValueOnce({ id: 'r1', sourceId: 's1', details: {} }).mockResolvedValueOnce({ id: 'r1', details: { cache: { a: 1 } } });
    await executeExtraction('r1', { ask: scriptedAsk });
    expect(lastUpdate()).toMatchObject({ status: 'cancelled', error: 'The extraction was cancelled.', details: { cache: { a: 1 } } });
    expect(writeResults).not.toHaveBeenCalled();
  });

  it('resumes from the previous run unless told not to', async () => {
    latestCache.mockResolvedValue({ old: 1 });
    await executeExtraction('r1', { ask: scriptedAsk });
    expect(latestCache).toHaveBeenCalledWith('s1');
    vi.clearAllMocks();
    getRun.mockResolvedValue({ id: 'r1', sourceId: 's1', details: { config: { resume: false } } });
    await executeExtraction('r1', { ask: scriptedAsk });
    expect(latestCache).not.toHaveBeenCalled();
  });

  it('fails clearly for a vanished run, transcript or an empty one', async () => {
    getRun.mockResolvedValue(null);
    await executeExtraction('r1', { ask: scriptedAsk });
    getRun.mockResolvedValue({ id: 'r1', sourceId: 's1', details: {} });
    getTranscript.mockResolvedValueOnce(null);
    await executeExtraction('r1', { ask: scriptedAsk });
    expect(lastUpdate().error).toContain('no longer exists');
    getPassages.mockResolvedValueOnce([]);
    await executeExtraction('r1', { ask: scriptedAsk });
    expect(lastUpdate().error).toContain('no text');
  });
});
