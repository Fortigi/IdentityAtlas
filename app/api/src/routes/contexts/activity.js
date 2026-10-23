// Context activity — an activity export (a time registration, an audit log) on a
// context, and what it shows about who works on it. Design:
// docs/architecture/context-activity.md.
//
//   POST   /api/contexts/:id/activity/analyze            multipart `file` → columns + best-guess mapping
//   POST   /api/contexts/:id/activity/preview            { uploadDraftId, mapping } → what apply would do
//   POST   /api/contexts/:id/activity/apply              { uploadDraftId, mapping } → the upload run
//   GET    /api/contexts/:id/activity?from&to            its people in four groups vs its members
//   GET    /api/contexts/:id/activity/summary?from&to    a parent: per sub-unit × month
//   GET    /api/contexts/:id/activity/uploads            the upload history
//   DELETE /api/contexts/:id/activity/uploads/:uploadId  undo one upload
//
// Writes need data.write.contexts (the gate of every context write), reads
// data.read. The intake and the failure answers are the list upload's
// (./uploads.js). Activity never changes membership or access.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { requirePermission } from '../../middleware/auth.js';
import { UUID_RE, writeContexts } from './shared.js';
import { fileReceiver, requireSql, sendFailure, MAX_UPLOAD_BYTES } from './uploads.js';
import { userOf } from '../../lib/userOf.js';
import { analyzeActivity, previewActivity, applyActivity, MAX_ACTIVITY_ROWS } from '../../contexts/activity/service.js';
import { contextActivity, activitySummary } from '../../contexts/activity/view.js';
import { listUploads, deleteUpload } from '../../contexts/activity/store.js';

const router = Router();
const readData = requirePermission('data.read', 'data.write.contexts');
const receiveFile = fileReceiver(
  `The file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB; an activity export for upload is at most ${MAX_ACTIVITY_ROWS.toLocaleString('en-US')} rows.`,
);

// The :id (and :uploadId) must be uuids; anything else is refused before the database sees it.
function validIds(req, res, next) {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid context id' });
  if (req.params.uploadId !== undefined && !UUID_RE.test(req.params.uploadId)) return res.status(400).json({ error: 'Invalid upload id' });
  return next();
}

// A string query parameter, or undefined (an array — ?from=a&from=b — is not one).
const param = (v) => (typeof v === 'string' ? v : undefined);
const periodQuery = (req) => ({ from: param(req.query.from), to: param(req.query.to) });

const write = [writeContexts, requireSql, validIds];
const read = [readData, requireSql, validIds];

router.post('/contexts/:id/activity/analyze', ...write, receiveFile, async (req, res) => {
  try {
    res.json(await analyzeActivity({
      buffer: req.file.buffer, fileName: req.file.originalname, uploadedBy: userOf(req), contextId: req.params.id,
    }, { db }));
  } catch (err) {
    sendFailure(res, err, 'Reading the activity export');
  }
});

router.post('/contexts/:id/activity/preview', ...write, async (req, res) => {
  try {
    res.json(await previewActivity(req.body || {}, req.params.id, { db }));
  } catch (err) {
    sendFailure(res, err, 'Previewing the activity upload');
  }
});

router.post('/contexts/:id/activity/apply', ...write, async (req, res) => {
  try {
    res.status(201).json(await applyActivity(req.body || {}, req.params.id, userOf(req), { db }));
  } catch (err) {
    sendFailure(res, err, 'Importing the activity');
  }
});

router.get('/contexts/:id/activity', ...read, async (req, res) => {
  try {
    res.json(await contextActivity(db, req.params.id, periodQuery(req)));
  } catch (err) {
    sendFailure(res, err, 'Reading the activity');
  }
});

router.get('/contexts/:id/activity/summary', ...read, async (req, res) => {
  try {
    res.json(await activitySummary(db, req.params.id, periodQuery(req)));
  } catch (err) {
    sendFailure(res, err, 'Reading the activity summary');
  }
});

router.get('/contexts/:id/activity/uploads', ...read, async (req, res) => {
  try {
    res.json({ data: await listUploads(db, req.params.id) });
  } catch (err) {
    sendFailure(res, err, 'Listing the activity uploads');
  }
});

router.delete('/contexts/:id/activity/uploads/:uploadId', ...write, async (req, res) => {
  try {
    const gone = await deleteUpload(db, req.params.id, req.params.uploadId);
    if (!gone) return res.status(404).json({ error: 'No such upload on this context.' });
    return res.json({ uploadId: gone.id, rowsRemoved: gone.rows });
  } catch (err) {
    return sendFailure(res, err, 'Undoing the activity upload');
  }
});

export default router;
