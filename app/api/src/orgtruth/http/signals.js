// Organisation truth — the activity signals per collection type (T10).
//
//   GET /api/org-truth/signals?type=<collection type>   { type, settings, asOf, findings } (signals/read.js)
//   GET /api/org-truth/signals/settings                 { [collectionType]: { inactiveAfterMonths, statusAttribute, inactiveValues } }
//   PUT /api/org-truth/signals/settings                 body: the same map, merged per type (null = back to defaults);
//                                                       → the stored map
//
// Reading needs READ_GATE; saving needs WRITE_GATE, the gate a profile edit
// takes. 400 { error } on a missing type, 400 { error, errors } on bad settings.
import { Router } from 'express';
import { READ_GATE, WRITE_GATE } from './gates.js';
import { handle, sendInvalid } from '../import/httpHelpers.js';
import { parseSettings, readSettings, writeSettings, MAX_TYPE_LENGTH } from '../signals/settings.js';
import { getSignals } from '../signals/read.js';

const router = Router();

router.get('/org-truth/signals/settings', ...READ_GATE, handle('read the signal settings', async (_req, res) => {
  res.json(await readSettings());
}));

router.put('/org-truth/signals/settings', ...WRITE_GATE, handle('save the signal settings', async (req, res) => {
  const { errors, value } = parseSettings(req.body);
  if (errors) return sendInvalid(res, 'The signal settings are not valid.', errors);
  res.json(await writeSettings(value));
}));

router.get('/org-truth/signals', ...READ_GATE, handle('compute the signals', async (req, res) => {
  const type = req.query.type;
  if (typeof type !== 'string' || !type.trim() || type.length > MAX_TYPE_LENGTH) {
    return res.status(400).json({ error: 'type is required' });
  }
  res.json(await getSignals(type));
}));

export default router;
