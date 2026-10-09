// Organisation truth — the Model tab's shared canvas layout (model/layout.js).
//
//   GET /api/org-truth/canvas-layout   { positions: { [cardId]: { x, y } }, updatedAt, updatedBy }
//   PUT /api/org-truth/canvas-layout   { positions } → the stored layout; { positions: {} } resets it
//
// Reading needs READ_GATE; saving needs WRITE_GATE, the same gate as editing a
// profile's link rules on that canvas. 400 { error, errors } on a malformed body.
import { Router } from 'express';
import { READ_GATE, WRITE_GATE } from './gates.js';
import { parseLayout, readLayout, writeLayout } from '../model/layout.js';
import { actorOf, handle, sendInvalid } from '../import/httpHelpers.js';

const router = Router();

router.get('/org-truth/canvas-layout', ...READ_GATE, handle('read the canvas layout', async (_req, res) => {
  res.json(await readLayout());
}));

router.put('/org-truth/canvas-layout', ...WRITE_GATE, handle('save the canvas layout', async (req, res) => {
  const { errors, value } = parseLayout(req.body);
  if (errors) return sendInvalid(res, 'The layout is not valid.', errors);
  res.json(await writeLayout(value.positions, actorOf(req)));
}));

export default router;
