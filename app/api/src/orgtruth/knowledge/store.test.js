import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
import { query, queryOne } from '../../db/connection.js';
import {
  claimSupport, writeResults, updateRun, createExtractRun, findTranscriptBySha, latestCache, failInterruptedRuns,
  requestCancel, isCancelRequested, insertTranscript, VIA,
} from './store.js';
import { PIPELINE_VERSION, PROMPT_VERSION } from './contracts.js';

beforeEach(() => { query.mockReset(); queryOne.mockReset(); });

describe('claimSupport', () => {
  it('one supported quote is enough; all unsupported means unsupported', () => {
    expect(claimSupport([{ support: 'unsupported' }, { support: 'supported' }])).toBe('supported');
    expect(claimSupport([{ support: 'unsupported' }, { support: 'unclear' }])).toBe('unclear');
    expect(claimSupport([{ support: 'unchecked' }])).toBe('unclear');
    expect(claimSupport([{ support: 'unsupported' }])).toBe('unsupported');
  });
});

describe('writeResults', () => {
  const run = { id: 'run-1' };
  const source = { id: 'src-1', observedAt: '2026-10-11T00:00:00.000Z' };
  const passages = [{ id: 'p-1', seq: 1 }, { id: 'p-2', seq: 2 }];
  const result = {
    mentions: [
      { key: 'person:rob', type: 'person', label: 'Rob', origin: 'model', occurrences: [{ seq: 1, startChar: 5, endChar: 8 }] },
      { key: 'team:kernteam', type: 'team', label: 'kernteam', origin: 'model', occurrences: [{ seq: 2, startChar: 60, endChar: 68 }] },
    ],
    claims: [
      { key: 'c1', subjectKey: 'person:rob', objectKey: 'team:kernteam', predicate: 'memberOf', qualifier: null, modality: 'stated', topic: 'membership',
        evidence: [{ seq: 1, startChar: 0, endChar: 20, quote: 'Rob zit in kernteam', support: 'supported', verifier: 'model' }] },
      { key: 'c2', subjectKey: 'person:rob', objectKey: 'team:kernteam', predicate: 'leads', qualifier: null, modality: 'implied', topic: null,
        evidence: [{ seq: 2, startChar: 30, endChar: 50, quote: 'Rob regelt het team', support: 'unsupported', verifier: 'model' }] },
      { key: 'orphan', subjectKey: 'person:none', objectKey: 'team:kernteam', predicate: 'memberOf', evidence: [] },
    ],
  };
  const resolutions = new Map([['person:rob', { status: 'candidates', candidates: [
    { targetType: 'Identity', targetId: 'id-rob', confidence: 79, signals: ['displayName token', 'displayName fuzzy'], matchedField: 'displayName', matchedValue: 'Rob Visser' },
  ] }]]);

  function client() {
    const calls = [];
    let n = 0;
    return { calls, query: async (sql, params) => { calls.push({ sql, params }); n += 1; return { rows: [{ id: `row-${n}` }] }; } };
  }

  it('stores mentions as proposed model entities under their prefixed type, with occurrences mapped to passage ids', async () => {
    const c = client();
    await writeResults(c, { run, source, passages, result, resolutions, findings: [] });
    const mentions = c.calls.filter(x => x.sql.includes('INSERT INTO "OrgEntities"'));
    expect(mentions).toHaveLength(2);
    expect(mentions[0].sql).toContain("'model', 'proposed'");
    expect(mentions[0].params[1]).toBe('Mentioned person');
    expect(mentions[0].params[3]).toBe('person:rob');
    expect(JSON.parse(mentions[0].params[4])).toEqual({
      mentionType: 'person', label: 'Rob', mentionOrigin: 'model', resolution: 'candidates',
      occurrences: [{ passageId: 'p-1', seq: 1, startChar: 5, endChar: 8 }],
    });
    expect(mentions[1].params[6]).toBe('passage:2');
    // a re-run never touches the status an analyst may have set
    expect(mentions[0].sql).not.toMatch(/DO UPDATE SET[^;]*"status"/);
  });

  it('every candidate becomes a proposed link via "mention" that a decided link keeps', async () => {
    const c = client();
    await writeResults(c, { run, source, passages, result, resolutions, findings: [] });
    const links = c.calls.filter(x => x.sql.includes('INSERT INTO "OrgLinks"'));
    expect(links).toHaveLength(1);
    expect(links[0].params.slice(2, 11)).toEqual(['Identity', 'id-rob', 79, 'displayName token,displayName fuzzy', 'displayName', 'Rob Visser', 'run-1', VIA, 'Rob']);
    expect(links[0].sql).toContain('WHERE "OrgLinks"."analystOverride" IS NULL');
  });

  it('statements carry claimKey, modality and support; the verifier lowers confidence but never rejects', async () => {
    const c = client();
    const counts = await writeResults(c, { run, source, passages, result, resolutions, findings: [] });
    const claims = c.calls.filter(x => x.sql.includes('INSERT INTO "OrgRelations"'));
    expect(claims).toHaveLength(2); // the orphan without a stored subject is skipped
    expect(JSON.parse(claims[0].params[4])).toEqual({ claimKey: 'c1', qualifier: null, modality: 'stated', topic: 'membership', support: 'supported' });
    expect(claims[0].params[8]).toBe('proposed');
    expect(claims[0].params[9]).toBe(80);
    expect(JSON.parse(claims[1].params[4])).toMatchObject({ support: 'unsupported' });
    expect(JSON.parse(claims[1].params[4]).rejectedBy).toBeUndefined();
    expect(claims[1].params[8]).toBe('proposed');
    expect(claims[1].params[9]).toBe(20);
    expect(claims[0].sql).not.toMatch(/DO UPDATE SET[^;]*"status"/);
    const evidence = c.calls.filter(x => x.sql.includes('INSERT INTO "OrgClaimEvidence"'));
    expect(evidence.map(e => [e.params[3], e.params[4], e.params[5], e.params[6], e.params[7]])).toEqual([
      ['p-1', 0, 20, 'Rob zit in kernteam', 'supported'], ['p-2', 30, 50, 'Rob regelt het team', 'unsupported'],
    ]);
    expect(counts).toMatchObject({ mentions: 2, links: 1, claims: 2, evidence: 2, findings: 0 });
  });

  it('findings point at stored ids and are keyed for idempotency', async () => {
    const c = client();
    const findings = [{ kind: 'question', category: 'ambiguous-name', text: 'Welke Rob?', related: { mentions: ['person:rob', 'missing'], claims: ['c1'], passages: [2, 9] }, origin: 'rule' }];
    await writeResults(c, { run, source, passages, result, resolutions, findings });
    const f = c.calls.find(x => x.sql.includes('INSERT INTO "OrgKnowledgeFindings"'));
    const related = JSON.parse(f.params[7]);
    expect(related.mentions).toHaveLength(1);
    expect(related.claims).toHaveLength(1);
    expect(related.passages).toEqual(['p-2']);
    expect(f.params[6]).toMatch(/^[0-9a-f]{40}$/);
    expect(f.sql).toContain('ON CONFLICT ("sourceId", "findingKey")');
  });
});

describe('runs and sources', () => {
  it('a run is an OrgImportRuns row with mode extract and both versions stamped', async () => {
    queryOne.mockResolvedValue({ id: 'r' });
    await createExtractRun({ sourceId: 's', triggeredBy: 'wim', config: { mode: 'pipeline' } });
    const [sql, params] = queryOne.mock.calls[0];
    expect(sql).toContain("'extract', 'queued'");
    expect(JSON.parse(params[3])).toEqual({ pipelineVersion: PIPELINE_VERSION, promptVersion: PROMPT_VERSION, config: { mode: 'pipeline' }, progress: null });
  });

  it('updateRun writes only known fields and serialises JSON ones', async () => {
    query.mockResolvedValue({ rows: [] });
    await updateRun('r', { step: 'resolve', pct: 88, details: { a: 1 }, evil: 'x' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toBe('UPDATE "OrgImportRuns" SET "step" = $2, "pct" = $3, "details" = $4 WHERE "id" = $1');
    expect(params).toEqual(['r', 'resolve', 88, '{"a":1}']);
  });

  it('duplicates are found by kind and hash; the cache comes from the latest run that has one', async () => {
    queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ cache: { k: 1 } }).mockResolvedValueOnce(null);
    expect(await findTranscriptBySha('abc')).toBeNull();
    expect(queryOne.mock.calls[0][0]).toContain(`"kind" = 'transcript' AND "sha256" = $1`);
    expect(await latestCache('s')).toEqual({ k: 1 });
    expect(await latestCache('s')).toEqual({});
  });

  it('cancel and the restart cleanup only touch active extraction runs', async () => {
    queryOne.mockResolvedValueOnce({ id: 'r' }).mockResolvedValueOnce({ cancelRequested: true });
    expect(await requestCancel('r')).toEqual({ id: 'r' });
    expect(queryOne.mock.calls[0][0]).toContain(`"mode" = 'extract' AND "status" IN ('queued', 'running')`);
    expect(await isCancelRequested('r')).toBe(true);
    query.mockResolvedValue({ rows: [{ id: 'a' }, { id: 'b' }] });
    expect(await failInterruptedRuns()).toBe(2);
    expect(query.mock.calls[0][0]).toContain(`WHERE "mode" = 'extract' AND "status" IN ('queued', 'running')`);
  });

  it('insertTranscript stores the bytes, the canonical text and one row per passage', async () => {
    const calls = [];
    const c = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 'new' }] }; } };
    await insertTranscript(c, {
      displayName: 'Interview', fileName: 'i.txt', mimeType: 'text/plain', buffer: Buffer.from('ab'), text: 'ab', sha256: 'h',
      observedAt: '2026-10-11', uploadedBy: 'wim', metadata: { language: 'nl' },
      passages: [{ seq: 1, startChar: 0, endChar: 2, text: 'ab', speaker: null, startMs: null, endMs: null }],
    });
    expect(calls[0].sql).toContain(`VALUES ($1, 'transcript'`);
    expect(calls[0].params.slice(1, 8)).toEqual(['Interview', 'i.txt', 'text/plain', 2, 'h', Buffer.from('ab'), 'ab']);
    expect(calls[1].sql).toContain('INSERT INTO "OrgSourcePassages"');
    expect(calls[1].params.slice(1)).toEqual([calls[0].params[0], 1, 0, 2, 'ab', null, null, null]);
  });
});
