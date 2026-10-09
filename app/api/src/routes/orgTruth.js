// Organisation truth — the composed API router.
//
// The feature is built as sub-routers under src/orgtruth/http/, one per
// workstream, so they can be developed in parallel without touching one
// another. This file only composes them and adds the one behaviour they share:
// any /org-truth path no sub-router claims answers 501 while the feature is on,
// and 404 while it is off (requireFeature), so a client never mistakes
// "not built yet" for "wrong URL".
//
// Not in openapi.yaml yet (listed in openapi.drift.test.js UNDOCUMENTED_FILES):
// document the routes there before this leaves the MVP stage.
import { Router } from 'express';
import { requireFeature } from '../featureFlags.js';
import { FEATURE } from '../orgtruth/http/gates.js';
import sources from '../orgtruth/http/sources.js';
import profiles from '../orgtruth/http/profiles.js';
import runs from '../orgtruth/http/runs.js';
import links from '../orgtruth/http/links.js';
import propose from '../orgtruth/http/propose.js';
import model from '../orgtruth/http/model.js';
import layout from '../orgtruth/http/layout.js';

const router = Router();

router.use(sources, profiles, runs, links, propose, model, layout);

// Everything under /org-truth that nothing above claimed.
router.all('/org-truth', requireFeature(FEATURE), notBuilt);
router.all('/org-truth/*splat', requireFeature(FEATURE), notBuilt);

function notBuilt(req, res) {
  res.status(501).json({ error: `Not built yet: ${req.method} ${req.path}` });
}

export default router;
