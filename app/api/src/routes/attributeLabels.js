// GET /api/attribute-labels — rawKey -> display name for extendedAttributes keys.
//
// The single source both readers use for attribute NAMES:
//   - the browser (entity detail tables, matrix headers, attribute pickers), and
//   - the Power Query workbook, whose M template looks the header up here rather
//     than re-implementing the extension-prefix rule in a second language.
//
// That is what makes "the Excel column header is character-identical to the one
// on screen" true by construction instead of by two implementations agreeing.
//
// Only keys that are actually relabelled appear in the response, so a caller can
// treat a missing key as "render it the way you always did".

import { Router } from 'express';
import { getAttributeLabels, LABEL_TARGET_TABLES } from '../lib/attributeLabels.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

router.get('/attribute-labels', async (req, res) => {
  const target = req.query.target;
  if (target !== undefined && !Object.prototype.hasOwnProperty.call(LABEL_TARGET_TABLES, target)) {
    return res.status(400).json({ error: `target must be one of: ${Object.keys(LABEL_TARGET_TABLES).join(', ')}` });
  }
  if (!useSql) return res.json({ labels: {} });
  try {
    return res.json({ labels: await getAttributeLabels(target) });
  } catch (err) {
    console.error('attribute-labels failed:', err.message);
    // An empty map degrades to the raw key everywhere — never a blank screen.
    return res.json({ labels: {} });
  }
});

export default router;
