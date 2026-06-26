// Shared helpers for route unit tests.
//
// The per-file `makeApp()` (express + json + mount router under /api) was being
// cloned across every route test (jscpd). This centralises it. Note: the
// `vi.mock(...)` calls themselves must stay in each test file — vitest hoists
// them above imports, so they can't be injected from here.

import express from 'express';

// Mount a single router under /api with JSON body parsing; returns the app for
// `request(app)`.
export function mountRouter(router) {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}
