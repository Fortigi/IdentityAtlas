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

// Same as mountRouter, but stamps a signed-in caller on every request before
// the router runs. `userForRequest(req)` returns the req.user object. Per-caller
// rate limiters (middleware/rateLimitKeys.js) key on req.user.oid, so a test can
// act as one admin across calls or as a fresh caller per request.
export function mountRouterAs(router, userForRequest) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = userForRequest(req); next(); });
  app.use('/api', router);
  return app;
}
