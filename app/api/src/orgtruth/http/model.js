// Organisation truth — the model and the entities (owned by workstream T4).
//
//   GET  /api/org-truth/model                  the meta-graph: entity types, predicates between types, links to system types, counts
//   GET  /api/org-truth/entities               list; ?type=&q=&status=&sourceId=&page=
//   GET  /api/org-truth/entities/:id           one entity: attributes, relations in and out, links, source, run
//   GET  /api/org-truth/entities/:id/graph     the detail page's fan-out rings (entityGraphShape.js contract)
import { Router } from 'express';

const router = Router();

export default router;
