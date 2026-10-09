// Organisation truth — the model's proposal (owned by workstream T3).
//
//   GET  /api/org-truth/propose/status         is the report generator reachable, is this prompt warm
//   POST /api/org-truth/propose/recipe         { sourceId } → { recipe, linkRules, origin: 'model' | 'heuristic', notes }
//
// Works without a model: the heuristic proposal (column names and value shapes)
// is the fallback, and the wizard lets the analyst edit either.
import { Router } from 'express';

const router = Router();

export default router;
