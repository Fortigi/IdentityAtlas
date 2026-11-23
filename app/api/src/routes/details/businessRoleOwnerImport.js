// Owners of many business roles from one list.
//
//   POST /api/business-roles/owners/import/preview  multipart `file` → what would change
//   POST /api/business-roles/owners/import/apply    multipart `file` → { written, kept, ... }
//
// Stateless: both read the file, so nothing is held between preview and apply.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { useSql } from './shared.js';
import { writeContexts } from '../contexts/shared.js';
import { receiveFile, sendFailure } from '../contexts/uploads.js';
import { parseList } from '../../contexts/upload/parse.js';
import { planOwnerImport, applyOwnerPlan } from '../../lib/businessRoleOwnerImport.js';

const router = Router();

const requireSql = (req, res, next) => (useSql ? next() : res.status(503).json({ error: 'SQL not configured' }));

async function planFromFile(req) {
  const table = await parseList(req.file.buffer, { fileName: req.file.originalname });
  return planOwnerImport(db, table);
}

router.post('/business-roles/owners/import/preview', writeContexts, requireSql, receiveFile, async (req, res) => {
  try {
    res.json(await planFromFile(req));
  } catch (err) {
    sendFailure(res, err, 'Reading the owner list');
  }
});

router.post('/business-roles/owners/import/apply', writeContexts, requireSql, receiveFile, async (req, res) => {
  try {
    const plan = await planFromFile(req);
    const result = await applyOwnerPlan(plan);
    res.json({ ...result, summary: plan.summary });
  } catch (err) {
    sendFailure(res, err, 'Importing the owner list');
  }
});

export default router;
