// Organisation truth — sources (owned by workstream T1).
//
//   POST /api/org-truth/sources                multipart upload (field `file`) + kind, displayName, observedAt
//   GET  /api/org-truth/sources                list (no content), with runCount and lastRunAt
//   GET  /api/org-truth/sources/:id            one source (no content)
//   GET  /api/org-truth/sources/:id/download   the original bytes
//   GET  /api/org-truth/sources/:id/columns    { rowCount, headerRow, columns } — column profile of a list source
//
// POST answers 201 with the stored row (never `content`) plus `rowCount`,
// `headerRow` (1-based file row taken as the header, parse.js) and `columns`
// (import/profileColumns.js shape), so the wizard needs no second call. A file the parser refuses is NOT stored: 400 with the parser's
// sentence. Only kind 'list' is accepted in the MVP (transcripts and mail need
// the extraction model that is not chosen yet).
import { Router } from 'express';
import multer from 'multer';
import { READ_GATE, WRITE_GATE } from './gates.js';
import { parseList } from '../import/parse.js';
import { profileColumns } from '../import/profileColumns.js';
import { getSource, getSourceWithContent, listSources, readSourceTable, insertSource } from '../import/sourceStore.js';
import { actorOf, handle, parseOr400 } from '../import/httpHelpers.js';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const SUPPORTED_KINDS = ['list'];

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

// multer as a step that answers its own errors with a sentence.
function receiveFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'The file is larger than 50 MB, the limit for an organisation list.' });
    return res.status(400).json({ error: `The upload could not be read (${err.message}); send one file in the field "file".` });
  });
}

// The form fields, checked. Returns { error } or the values to store.
export function readUploadFields(body, file) {
  const kind = body?.kind || 'list';
  if (!SUPPORTED_KINDS.includes(kind)) return { error: `Source kind "${kind}" cannot be imported yet; upload a list (xlsx or csv).` };
  const observedAt = body?.observedAt ? new Date(body.observedAt) : new Date();
  if (Number.isNaN(observedAt.getTime())) return { error: `observedAt "${body.observedAt}" is not a date; use ISO 8601, for example 2026-10-01.` };
  const displayName = String(body?.displayName ?? '').trim() || file.originalname;
  return { kind, observedAt: observedAt.toISOString(), displayName };
}

const tableResponse = ({ columns, rows, headerRow }) => ({ rowCount: rows.length, headerRow, columns: profileColumns(columns, rows) });

router.post('/org-truth/sources', ...WRITE_GATE, receiveFile, handle('store the source', async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file was uploaded; send it in the multipart field "file".' });
  const fields = readUploadFields(req.body, req.file);
  if (fields.error) return res.status(400).json({ error: fields.error });
  const { buffer, originalname, mimetype } = req.file;
  const table = await parseOr400(res, () => parseList(buffer, { fileName: originalname, mimeType: mimetype }));
  if (!table) return;
  const row = await insertSource({
    ...fields, fileName: originalname, mimeType: mimetype, buffer, uploadedBy: actorOf(req),
  });
  res.status(201).json({ ...row, ...tableResponse(table) });
}));

router.get('/org-truth/sources', ...READ_GATE, handle('list the sources', async (_req, res) => {
  res.json(await listSources());
}));

router.get('/org-truth/sources/:id', ...READ_GATE, handle('read the source', async (req, res) => {
  const row = await getSource(req.params.id);
  if (!row) return res.status(404).json({ error: 'Source not found.' });
  res.json(row);
}));

router.get('/org-truth/sources/:id/download', ...READ_GATE, handle('download the source', async (req, res) => {
  const row = await getSourceWithContent(req.params.id);
  if (!row?.content) return res.status(404).json({ error: 'Source not found.' });
  res.attachment(row.fileName || row.displayName);
  res.set('Content-Type', row.mimeType || 'application/octet-stream');
  res.send(Buffer.from(row.content));
}));

router.get('/org-truth/sources/:id/columns', ...READ_GATE, handle('profile the source', async (req, res) => {
  const row = await getSourceWithContent(req.params.id);
  if (!row) return res.status(404).json({ error: 'Source not found.' });
  const table = await parseOr400(res, () => readSourceTable(row));
  if (!table) return;
  res.json(tableResponse(table));
}));

export default router;
