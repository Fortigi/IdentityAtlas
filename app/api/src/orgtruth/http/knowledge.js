// Organisation knowledge extraction — transcripts and extraction runs (experimental).
//
//   GET  /api/org-truth/knowledge/status                   is a local model configured and reachable?
//   POST /api/org-truth/knowledge/sources                  upload (multipart "file") or paste ("text"); 201, or 200 + duplicate
//   GET  /api/org-truth/knowledge/sources                  the transcripts, each with its latest run
//   GET  /api/org-truth/knowledge/sources/:id              metadata, canonical text, passages, runs
//   POST /api/org-truth/knowledge/sources/:id/extract      { mode?: 'pipeline'|'single', resume?: boolean } → 202 run
//   GET  /api/org-truth/knowledge/runs/:id                 status, step, pct, stats (no stage cache)
//   GET  /api/org-truth/knowledge/runs/:id/diagnostics     the whole pipeline state incl. per-stage outputs
//   POST /api/org-truth/knowledge/runs/:id/cancel          stop after the current model call
// Deleting a transcript is the generic DELETE /api/org-truth/sources/:id.
import { Router } from 'express';
import multer from 'multer';
import { tx } from '../../db/connection.js';
import { actorOf, handle, isUuid } from '../import/httpHelpers.js';
import { KNOWLEDGE_READ, KNOWLEDGE_WRITE, canSee } from '../knowledge/access.js';
import { readTranscriptRequest, prepareTranscript } from '../knowledge/ingest.js';
import { modelStatus } from '../knowledge/model.js';
import {
  findTranscriptBySha, insertTranscript, listTranscripts, getTranscript, getPassages,
  createExtractRun, findActiveExtraction, getRun, requestCancel,
} from '../knowledge/store.js';
import { listRuns } from '../knowledge/read.js';
import { startExtraction } from '../knowledge/run.js';

export const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;
const MODES = ['pipeline', 'single'];

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_TRANSCRIPT_BYTES, files: 1 } });

function receiveFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'The transcript is larger than 5 MB.' });
    return res.status(400).json({ error: `The upload could not be read (${err.message}).` });
  });
}

const withoutCache = (run) => {
  if (!run) return run;
  const { cache, ...details } = run.details ?? {};
  return { ...run, details, cachedCalls: cache ? Object.keys(cache).length : 0 };
};

async function visibleTranscript(req, res) {
  const source = await getTranscript(req.params.id);
  if (!source || !canSee(req, source)) {
    res.status(404).json({ error: 'Transcript not found.' });
    return null;
  }
  return source;
}

router.get('/org-truth/knowledge/status', ...KNOWLEDGE_READ, handle('read the model status', async (_req, res) => {
  const status = await modelStatus();
  const active = await findActiveExtraction();
  res.json({ ...status, activeRunId: active?.id ?? null, setup: status.configured ? null : 'Enable the report generator (local model) for this deployment: NL_REPORTS_LLM_URL.' });
}));

router.post('/org-truth/knowledge/sources', ...KNOWLEDGE_WRITE, receiveFile, handle('store the transcript', async (req, res) => {
  const request = readTranscriptRequest({ body: req.body, file: req.file });
  if (request.error) return res.status(400).json({ error: request.error });
  const prepared = prepareTranscript(request);
  if (prepared.error) return res.status(400).json({ error: prepared.error });
  const existing = await findTranscriptBySha(prepared.sha256);
  if (existing) return res.status(200).json({ ...existing, duplicate: true });
  const row = await tx(client => insertTranscript(client, {
    displayName: request.fields.displayName, fileName: request.fileName, mimeType: request.mimeType, buffer: request.buffer,
    text: prepared.text, sha256: prepared.sha256, observedAt: request.fields.observedAt, uploadedBy: actorOf(req),
    metadata: prepared.metadata, passages: prepared.passages,
  }));
  console.log(`org-knowledge: transcript "${row.displayName}" (${row.id}, ${prepared.passages.length} passages) stored by ${actorOf(req)}`);
  res.status(201).json({ ...row, duplicate: false });
}));

router.get('/org-truth/knowledge/sources', ...KNOWLEDGE_READ, handle('list the transcripts', async (req, res) => {
  res.json((await listTranscripts()).filter(s => canSee(req, s)));
}));

router.get('/org-truth/knowledge/sources/:id', ...KNOWLEDGE_READ, handle('read the transcript', async (req, res) => {
  const source = await visibleTranscript(req, res);
  if (!source) return;
  const [passages, runs] = await Promise.all([getPassages(source.id), listRuns(source.id)]);
  res.json({ ...source, passages, runs });
}));

router.post('/org-truth/knowledge/sources/:id/extract', ...KNOWLEDGE_WRITE, handle('start the extraction', async (req, res) => {
  const source = await visibleTranscript(req, res);
  if (!source) return;
  const mode = req.body?.mode ?? 'pipeline';
  if (!MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${MODES.join(', ')}.` });
  const status = await modelStatus();
  if (!status.reachable) {
    return res.status(409).json({
      error: status.configured ? 'The local model is not reachable; try again when the report generator is up.' : 'No local model is configured for this deployment.',
      setup: 'Knowledge extraction runs only on the deployment\'s own local model (the report generator); nothing is sent to an external AI.',
    });
  }
  const active = await findActiveExtraction();
  if (active) return res.status(409).json({ error: 'Another extraction is running; the local model reads one transcript at a time.', runId: active.id });
  const run = await createExtractRun({ sourceId: source.id, triggeredBy: actorOf(req), config: { mode, resume: req.body?.resume !== false } });
  startExtraction(run.id);
  res.status(202).json(withoutCache(run));
}));

router.get('/org-truth/knowledge/runs/:id', ...KNOWLEDGE_READ, handle('read the run', async (req, res) => {
  const run = await getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found.' });
  res.json(withoutCache(run));
}));

router.get('/org-truth/knowledge/runs/:id/diagnostics', ...KNOWLEDGE_WRITE, handle('read the run diagnostics', async (req, res) => {
  const run = await getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found.' });
  res.json(run);
}));

router.post('/org-truth/knowledge/runs/:id/cancel', ...KNOWLEDGE_WRITE, handle('cancel the run', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Run not found.' });
  const row = await requestCancel(req.params.id);
  if (!row) return res.status(409).json({ error: 'The run is not queued or running.' });
  res.json({ id: row.id, cancelRequested: true });
}));

export default router;
