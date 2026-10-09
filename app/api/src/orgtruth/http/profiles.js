// Organisation truth — import profiles (owned by workstream T1).
//
//   GET  /api/org-truth/profiles               every profile, latest version first
//   GET  /api/org-truth/profiles/:id           one version
//   POST /api/org-truth/profiles               create (name, sourceKind, recipe, linkRules) → version 1
//   PUT  /api/org-truth/profiles/:id           a new version of the same name (never edits a version in place)
import { Router } from 'express';

const router = Router();

export default router;
