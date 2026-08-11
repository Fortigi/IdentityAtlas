// Shared helpers for route unit tests.
//
// The per-file `makeApp()` (express + json + mount router under /api) was being
// cloned across every route test (jscpd). This centralises it. Note: the
// `vi.mock(...)` calls themselves must stay in each test file — vitest hoists
// them above imports, so they can't be injected from here.
//
// For the DB mock specifically, that hoisting problem is solved a different way:
// `src/db/__mocks__/connection.js` is a vitest *manual mock*, so a test writes
// `vi.mock('../db/connection.js')` with no factory and imports the `query` /
// `queryOne` spies from the same path. Use that instead of hand-rolling an
// inline factory.

import express from 'express';

// Mount a single router under /api with JSON body parsing; returns the app for
// `request(app)`.
export function mountRouter(router) {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}
