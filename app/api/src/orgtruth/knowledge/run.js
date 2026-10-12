// Organisation knowledge extraction — one extraction run, end to end, in the background.
//
//   executeExtraction(runId, { ask })   → the awaited body (tests inject a scripted `ask`)
//   startExtraction(runId)              → fire-and-forget; never awaited by an HTTP handler
//
// Steps stamped on the run row (`step`, `pct`; the UI polls GET /knowledge/runs/:id):
//   stages (5–85, per model call) → resolve (88) → findings (92) → write (96) → completed (100)
// The model calls are the slow part (minutes per passage on a CPU box): progress is
// written after each call, and the stage cache is saved with the run so a run that
// is cancelled, fails or is cut off by a restart resumes where it stopped.
// Writing is one transaction: a run either adds all its rows or none.
import { tx } from '../../db/connection.js';
import { ask as modelAsk, modelStatus } from './model.js';
import { runPipeline, CancelledError } from './pipeline.js';
import { resolveMentions } from './resolve.js';
import { renamedMentions } from './mentions.js';
import { rescoreSource } from './corroboration.js';
import { ruleFindings, modelFindings, directoryFindings } from './findings.js';
import {
  getRun, getTranscript, getPassages, updateRun, isCancelRequested, latestCache, writeResults,
} from './store.js';

const now = () => new Date().toISOString();
export const PROGRESS_EVERY_MS = 3000;

function progressWriter(runId, details) {
  let last = 0;
  return async ({ phase, done, total }) => {
    details.progress = { phase, done, total };
    if (Date.now() - last < PROGRESS_EVERY_MS && done < total) return;
    last = Date.now();
    await updateRun(runId, { step: phase, pct: Math.min(85, 5 + Math.round((80 * done) / Math.max(total, 1))), details });
  };
}

function summary(result, written, model, startedMs) {
  return {
    model,
    mode: result.mode,
    durationMs: Date.now() - startedMs,
    passages: Object.keys(result.topics).length,
    written,
    claimsBySupport: result.claims.reduce((acc, c) => {
      const s = c.evidence.some(e => e.support === 'supported') ? 'supported' : (c.evidence.every(e => e.support === 'unsupported') ? 'unsupported' : 'unclear');
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {}),
    pipeline: result.stats,
  };
}

async function steps(runId, ask, startedMs) {
  const run = await getRun(runId);
  if (!run) throw new Error(`Extraction run ${runId} does not exist.`);
  const details = { ...(run.details ?? {}) };
  const source = await getTranscript(run.sourceId);
  if (!source) throw new Error('The run\'s transcript no longer exists.');
  const passages = await getPassages(source.id);
  if (passages.length === 0) throw new Error('The transcript has no text to read.');

  const status = await modelStatus();
  if (!status.reachable) throw new Error(status.configured ? `The local model is not reachable (${status.error ?? 'no answer'}).` : 'No local model is configured (NL_REPORTS_LLM_URL).');
  details.model = status.model;
  details.startedAt = now();
  const cache = details.config?.resume === false ? {} : await latestCache(source.id);
  details.cache = cache;
  await updateRun(runId, { status: 'running', step: 'stages', pct: 5, startedAt: now(), details });

  const language = source.metadata?.language ?? 'nl';
  const result = await runPipeline({
    passages, ask, cache, mode: details.config?.mode ?? 'pipeline', language,
    onProgress: progressWriter(runId, details),
    isCancelled: () => isCancelRequested(runId),
  });
  details.cache = result.cache;
  details.topics = result.topics;
  details.errors = result.errors;

  await updateRun(runId, { step: 'resolve', pct: 88, details });
  // A mention the reviewer renamed or retyped is matched (and asked about) under its new name.
  const edits = await renamedMentions(source.id);
  const effective = result.mentions.map(m => (edits.has(m.key) ? { ...m, ...edits.get(m.key) } : m));
  const resolutions = await resolveMentions(effective);

  await updateRun(runId, { step: 'findings', pct: 92 });
  const findings = [
    ...ruleFindings({ mentions: effective, resolutions, claims: result.claims, language }),
    ...modelFindings(result.findings, passages),
    ...await directoryFindings({ claims: result.claims, resolutions, language }),
  ];

  await updateRun(runId, { step: 'write', pct: 96 });
  const written = await tx(client => writeResults(client, { run, source, passages, result, resolutions, findings }));
  // confidence + corroboration by the existing data, over every statement of the source
  written.confidence = await rescoreSource(source.id);
  details.finishedAt = now();
  return { stats: summary(result, written, status.model, startedMs), details };
}

async function saveCacheFrom(runId) {
  // keep whatever the pipeline cached so far for a resume (details.cache is mutated in place)
  const run = await getRun(runId);
  return run?.details ?? null;
}

export async function executeExtraction(runId, { ask = modelAsk } = {}) {
  const log = (msg) => console.log(`[org-knowledge ${runId}] ${msg}`);
  const startedMs = Date.now();
  try {
    const { stats, details } = await steps(runId, ask, startedMs);
    await updateRun(runId, { status: 'completed', step: 'completed', pct: 100, stats, details, finishedAt: now() });
    log(`completed: ${stats.written.claims} statements, ${stats.written.mentions} mentions, ${stats.written.findings} findings in ${Math.round(stats.durationMs / 1000)} s`);
  } catch (err) {
    const cancelled = err instanceof CancelledError;
    const details = await saveCacheFrom(runId).catch(() => null);
    await updateRun(runId, {
      status: cancelled ? 'cancelled' : 'failed', error: err.message, finishedAt: now(), ...(details ? { details } : {}),
    });
    log(`${cancelled ? 'cancelled' : 'failed'}: ${err.message}`);
  }
}

export function startExtraction(runId) {
  executeExtraction(runId).catch(err => console.error(`Background knowledge extraction ${runId} crashed:`, err));
}
