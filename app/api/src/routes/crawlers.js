// Crawler endpoints (barrel).
//
// This controller grew past the ~600-line "smell" threshold (audit finding C1),
// so it's split by responsibility into focused routers under ./crawlers/:
//
//   crawlers/admin.js       — /api/admin/crawlers[...] (Entra ID auth) -> adminCrawlersRouter
//   crawlers/selfService.js — /api/crawlers/* (API-key auth: self-service, worker
//                             job-claim protocol, delta-token persistence) -> selfServiceCrawlersRouter
//   crawlers/shared.js      — useSql + the API-key generateApiKey / hashKey helpers
//
// app.js mounts the two routers separately (different auth middleware), and the
// OpenAPI-drift guard introspects both, so this file re-exports the two named
// routers exactly as before — no default export.

export { adminCrawlersRouter } from './crawlers/admin.js';
export { selfServiceCrawlersRouter } from './crawlers/selfService.js';
