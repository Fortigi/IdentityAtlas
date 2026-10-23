// Context uploads — an analyst's own list (customers, an application register)
// as a context tree. Design: docs/architecture/context-upload.md.
//
//   GET  /api/contexts/uploads          the uploaded lists, each with its latest upload
//   POST /api/contexts/uploads/analyze  multipart `file` (+ `listId`) → columns + best-guess mapping
//   POST /api/contexts/uploads/preview  { uploadDraftId, mapping, listId? } → what apply would do
//   POST /api/contexts/uploads/apply    { uploadDraftId, mapping, listId?, removeMissing? } → result
//
// All four need data.write.contexts (the same gate as every context write).
// Mounted BEFORE the read router: "/contexts/uploads" would otherwise be taken
// for "/contexts/:id" and refused as a malformed id.

import { Router } from 'express';
import multer from 'multer';
import * as db from '../../db/connection.js';
import { useSql, writeContexts } from './shared.js';
import { userOf } from '../../lib/userOf.js';
import { ListParseError } from '../../contexts/upload/parse.js';
import { analyzeUpload, previewUpload, applyUpload, UploadError } from '../../contexts/upload/service.js';
import { listLists } from '../../contexts/upload/lists.js';
import { runIngest } from '../ingest/handlers.js';
import { insertRoleRows, insertRelationshipRows } from '../ingest/contextLinks.js';
import { refreshMemberCounts } from '../../contexts/memberCounts.js';

const router = Router();

// Not a crawler-style file cap: a list is at most 50,000 rows (parse.js), which
// no real list reaches in this many bytes. It bounds the memory one request may
// take, since a workbook has to be read whole.
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const ALLOWED = /\.(csv|txt|xlsx)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, cb) => (ALLOWED.test(file.originalname)
    ? cb(null, true)
    : cb(new ListParseError('Upload a .csv or .xlsx file.'))),
});

const deps = () => ({ db, runIngest, insertRoleRows, insertRelationshipRows, refreshMemberCounts });

// One answer for every failure: a sentence the analyst can act on for their own
// mistakes, a generic one (and the detail in the log) for ours.
export function sendFailure(res, err, label) {
  if (err instanceof ListParseError) return res.status(400).json({ error: err.message });
  if (err instanceof UploadError) return res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
  console.error(`${label} failed:`, err?.message);
  return res.status(500).json({ error: `${label} failed` });
}

// The multipart intake of one `file`, answering a too-large file with
// `tooLarge` (a sentence) — shared with the activity upload (./activity.js).
export function fileReceiver(tooLarge) {
  return function receiveFile(req, res, next) {
    upload.single('file')(req, res, (err) => {
      if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: tooLarge });
      if (err) return res.status(400).json({ error: err instanceof ListParseError ? err.message : 'The file could not be received.' });
      if (!req.file) return res.status(400).json({ error: 'Choose a file to upload (field "file").' });
      return next();
    });
  };
}
const receiveFile = fileReceiver(`The file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB; a list for upload is at most 50,000 rows.`);

export const requireSql = (req, res, next) => (useSql ? next() : res.status(503).json({ error: 'SQL not configured' }));

router.get('/contexts/uploads', writeContexts, requireSql, async (req, res) => {
  try {
    res.json({ data: await listLists(db) });
  } catch (err) {
    sendFailure(res, err, 'Listing uploaded lists');
  }
});

router.post('/contexts/uploads/analyze', writeContexts, requireSql, receiveFile, async (req, res) => {
  try {
    res.json(await analyzeUpload({
      buffer: req.file.buffer,
      fileName: req.file.originalname,
      uploadedBy: userOf(req),
      listId: req.body?.listId || null,
    }, { db }));
  } catch (err) {
    sendFailure(res, err, 'Reading the list');
  }
});

router.post('/contexts/uploads/preview', writeContexts, requireSql, async (req, res) => {
  try {
    res.json(await previewUpload(req.body || {}, { db }));
  } catch (err) {
    sendFailure(res, err, 'Previewing the upload');
  }
});

router.post('/contexts/uploads/apply', writeContexts, requireSql, async (req, res) => {
  try {
    res.status(201).json(await applyUpload(req.body || {}, userOf(req), deps()));
  } catch (err) {
    sendFailure(res, err, 'Importing the list');
  }
});

export default router;
