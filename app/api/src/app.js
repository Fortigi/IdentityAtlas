// Express application factory.
//
// createApp() builds and returns the fully-wired Express app (security headers,
// CORS, body parsing, all route mounts, SPA fallback) WITHOUT binding a port or
// running startup side-effects (loadAuthConfig, bootstrapWorker, app.listen).
// That lives in index.js (the process entry point).
//
// Splitting it this way lets tests import the real app and drive it with
// supertest — see src/auth/permissionMatrix.test.js — instead of duplicating
// the middleware chain or spinning up a real server.

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { authMiddleware } from './middleware/auth.js';
import { resolveModuleVersion } from './version.js';
import { perfMetrics } from './middleware/perfMetrics.js';
import permissionsRouter from './routes/permissions.js';
import matrixRouter from './routes/matrix.js';
import effectiveAccessRouter from './routes/effectiveAccess.js';
import tagsRouter from './routes/tags.js';
import categoriesRouter from './routes/categories.js';
import detailsRouter from './routes/details.js';
import recentChangesRouter from './routes/recentChanges.js';
import governanceRouter from './routes/governance.js';
import perfRouter from './routes/perf.js';
import riskRouter from './routes/riskScores.js';
import orgChartRouter from './routes/orgChart.js';
import identitiesRouter from './routes/identities.js';
import preferencesRouter from './routes/preferences.js';
import systemsRouter from './routes/systems.js';
import resourcesRouter from './routes/resources.js';
import contextsRouter from './routes/contexts.js';
import contextPluginsRouter from './routes/contextPlugins.js';
import adminRouter from './routes/admin.js';
import authRolesRouter from './routes/authRoles.js';
import llmRouter from './routes/llm.js';
import riskProfilesRouter from './routes/riskProfiles.js';
import riskScoringRunsRouter from './routes/riskScoringRuns.js';
import accountLinkingRouter from './routes/accountLinking.js';
import { adminCrawlersRouter, selfServiceCrawlersRouter } from './routes/crawlers.js';
import { crawlerAuthMiddleware } from './middleware/crawlerAuth.js';
import ingestRouter from './routes/ingest.js';
import jobsRouter from './routes/jobs.js';
import crawlerFilesRouter from './routes/crawlerFiles.js';
import dataExportRouter from './routes/dataExport.js';
import bulkListsRouter from './routes/bulkLists.js';
import updatesRouter from './routes/updates.js';
import { isAuthEnabled, getTenantId, getClientId } from './config/authConfig.js';
import { isSchemaReady } from './startupState.js';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === 'production';

// Schema-migration gate (#696): while the DB schema is still migrating (see
// index.js + startupState.js), every schema-dependent /api endpoint returns 503
// Retry-After instead of a raw 500 from a not-yet-existing schema — so no crawler
// runs against a mid-migration schema AND the UI can show a "warming up" state
// and retry rather than a 500 stack. Mounted once on /api, AFTER the platform
// probe + bootstrap endpoints (health/version/features/auth-config/auth-me) which
// stay available. Inert in tests / mock mode (isSchemaReady() is true unless
// index.js armed the gate at real startup), so createApp()-built unit tests are
// unaffected.
//
// The crawler self-service endpoints stay reachable even mid-migration so a
// worker can still authenticate (whoami) and rotate its key, then back off
// cleanly on the 503s it gets from the gated data-plane.
const SCHEMA_GATE_OPEN_PATHS = ['/api/crawlers/whoami', '/api/crawlers/rotate'];
function schemaMigratingGate(req, res, next) {
  if (isSchemaReady()) return next();
  if (SCHEMA_GATE_OPEN_PATHS.includes(req.originalUrl.split('?')[0])) return next();
  res.set('Retry-After', '30');
  return res.status(503).json({ error: 'Schema migration in progress, please retry shortly' });
}

// Minimum compose file version this image expects. A deployment whose
// docker-compose.prod.yml declares a lower COMPOSE_FILE_VERSION is flagged as
// outdated on the Dashboard, prompting the operator to re-download the current
// file.
//
// Raised to 2 to reach deployments still on a version-1 compose file. Version-1
// files predate security-relevant fixes that live only in the compose file (not
// the image): the removal of the /var/run/docker.sock bind-mount + group_add:
// ["0"] from the web container (H-05 / #213 — a host-takeover primitive), and
// binding Postgres to loopback instead of all interfaces. Bumping the floor is
// what actually arms the warning for those deployments — #213 removed the mount
// but left the floor at 1, so a version-1 file was never flagged.
const MIN_COMPOSE_FILE_VERSION = 2;

// Resolve module version: env var (set on the published images) → fallback to
// the .psd1 manifest (source / dev / local builds). Shared with the auto-update
// channel logic via version.js so both always agree.
const moduleVersion = resolveModuleVersion();

// Helper: read a feature flag override from WorkerConfig (overrides the env var)
async function getFeatureOverride(key) {
  if (process.env.USE_SQL !== 'true') return null;
  try {
    const db = await import('./db/connection.js');
    const r = await db.queryOne(
      `SELECT "configValue" FROM "WorkerConfig" WHERE "configKey" = $1`,
      [`FEATURE_${key}`]
    );
    if (!r) return null;
    const v = r.configValue;
    return v === 'true' ? true : v === 'false' ? false : null;
  } catch (err) {
    console.warn(`getFeatureOverride(${key}) failed: ${err.message}`);
    return null;
  }
}

// Build and return the fully-wired Express app. No port binding, no startup
// side-effects — the caller (index.js) owns those.
export function createApp() {
  const app = express();

  // ─── Security headers ────────────────────────────────────────────
  // HSTS and CSP `upgrade-insecure-requests` are opt-in via BEHIND_TLS=true.
  // The default deployment story is plain HTTP on port 3001; sending these
  // headers over HTTP traps browsers into HTTPS-only for a year and then fails
  // because there's no TLS listener. Set BEHIND_TLS=true only when a TLS
  // terminator (Caddy, nginx, Azure Front Door) sits in front of the container.
  const behindTls = process.env.BEHIND_TLS === 'true';
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],  // Tailwind uses inline styles
        fontSrc: ["'self'"],
        connectSrc: [
          "'self'",
          'https://login.microsoftonline.com',
          'https://graph.microsoft.com',
        ],
        frameSrc: ["'self'", 'https://login.microsoftonline.com'],
        imgSrc: ["'self'", 'data:'],
        upgradeInsecureRequests: behindTls ? [] : null,
      },
    },
    strictTransportSecurity: behindTls,
    crossOriginEmbedderPolicy: false,  // Required for MSAL redirects
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));

  // ─── CORS ────────────────────────────────────────────────────────
  // ALLOWED_ORIGINS must not contain '*' — filter it out to prevent accidental
  // broad access. In development, restrict to known localhost origins instead
  // of `true` (which would allow any origin including cross-site attackers).
  const DEV_ORIGINS = [
    'http://localhost:5173', 'http://localhost:3000', 'http://localhost:3001',
    'http://127.0.0.1:5173', 'http://127.0.0.1:3000', 'http://127.0.0.1:3001',
  ];
  const corsOptions = {
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(o => o && o !== '*')
      : isProduction
        ? false  // Disallow cross-origin in production if not explicitly configured
        : DEV_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Server-Timing'],  // Allow browser to read Server-Timing header
  };
  app.use(cors(corsOptions));

  // ─── Body parsing with size limits ───────────────────────────────
  // Route-specific parsers for large payloads are set below (ingest: 10mb, import: 2mb).
  // The global parser handles all other routes with a conservative limit.
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/ingest') || req.path.startsWith('/api/admin/import')) {
      return next(); // Skip global parser — route-specific parsers handle these
    }
    express.json({ limit: '100kb' })(req, res, next);
  });

  // ─── Performance metrics middleware (before routes, after body parsing) ─
  app.use('/api', perfMetrics);

  // ─── Swagger / OpenAPI docs (public) ─────────────────────────────
  try {
    const openapiSpec = YAML.load(join(__dirname, 'openapi.yaml'));
    app.get('/api/openapi.json', (req, res) => res.json(openapiSpec));
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, {
      customSiteTitle: 'Identity Atlas Ingest API',
    }));
  } catch {
    // OpenAPI spec not available — skip Swagger UI
  }

  // ─── Rate limiting on unauthenticated endpoints ──────────────────
  const publicLimiter = rateLimit({
    windowMs: 60 * 1000,  // 1 minute
    max: 30,               // 30 requests per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
  });

  // Authenticated /api/* endpoints get a permissive global limit. The
  // point is just to bound DoS / credential-stuffing against the auth
  // middleware itself — which CodeQL flags as "authorization without
  // rate limiting" otherwise. The cap must NOT bite normal interactive
  // use (matrix page fires 20+ calls on load) or parallel CI tests
  // running through a single source IP, so we leave wide headroom.
  //   6000 req/min  =  100 req/sec sustained per IP
  const authedApiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 6000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down' },
  });
  app.use('/api', authedApiLimiter);

  // Unauthenticated endpoints (rate-limited)
  // Always 200 so the platform startup/health probe passes as soon as the port
  // is open — even while migrations still run in the background (see index.js).
  // A non-200 here would let App Service kill the container mid-migration and
  // recreate the crash loop this design fixes. `schemaReady` reports the real
  // migration state for observability without failing the probe.
  app.get('/api/health', publicLimiter, (req, res) => {
    res.json({ status: 'ok', schemaReady: isSchemaReady() });
  });

  app.get('/api/version', publicLimiter, (req, res) => {
    const composeFileVersion = parseInt(process.env.COMPOSE_FILE_VERSION || '0', 10);
    res.json({
      version: moduleVersion || null,
      composeFileVersion: composeFileVersion || null,
      minComposeFileVersion: MIN_COMPOSE_FILE_VERSION,
      composeFileOutdated: composeFileVersion > 0 && composeFileVersion < MIN_COMPOSE_FILE_VERSION,
    });
  });

  app.get('/api/features', publicLimiter, async (req, res) => {
    // WorkerConfig overrides win over env vars; env vars are the fallback default.
    // Risk Scoring defaults to OFF on a fresh install — opt-in via the toggle
    // in Admin → Risk Scoring or via FEATURE_RISK_SCORING=true.
    const riskOverride = await getFeatureOverride('RISK_SCORING');
    // Account linking (formerly "account correlation"). Honour the new override
    // key, falling back to the legacy one + legacy env var so upgrades keep their setting.
    const linkOverride = (await getFeatureOverride('ACCOUNT_LINKING')) ?? (await getFeatureOverride('ACCOUNT_CORRELATION'));
    res.json({
      riskScoring: riskOverride !== null
        ? riskOverride
        : process.env.FEATURE_RISK_SCORING === 'true',
      accountLinking: linkOverride !== null
        ? linkOverride
        : (process.env.FEATURE_ACCOUNT_LINKING ?? process.env.FEATURE_ACCOUNT_CORRELATION) !== 'false',
    });
  });

  app.get('/api/auth-config', publicLimiter, (req, res) => {
    // Reads the live config from authConfig.js so a UI-driven save takes effect
    // immediately for any new browser session.
    //
    // `configured` distinguishes two enabled-but-different states for the SPA:
    //   enabled=true, configured=true   → run MSAL sign-in
    //   enabled=true, configured=false  → show the "set up Entra" page instead
    //                                     of trying to sign in (happens on Azure
    //                                     between Step 1 and Step 2 of the
    //                                     walkthrough, when the env vars are
    //                                     still empty)
    //
    // `platform` lets the setup page render Azure-specific or Docker-specific
    // instructions. Same WEBSITE_SITE_NAME check that admin.js uses.
    const enabled = isAuthEnabled();
    const tenantId = enabled ? (getTenantId() || '') : '';
    const clientId = enabled ? (getClientId() || '') : '';
    const platform = process.env.WEBSITE_SITE_NAME ? 'azure-app-service' : 'docker';
    res.json({
      enabled,
      configured: enabled && !!tenantId && !!clientId,
      tenantId,
      clientId,
      platform,
    });
  });

  // What permissions does the *current request* have? UI calls this once after
  // sign-in (and after editing the mapping) to drive feature-flag-style gating —
  // hide Admin tab, hide export buttons, etc. Server is source of truth for the
  // role→permission mapping; mirroring the resolution in the UI would drift.
  //
  // Behaviour:
  //   - Auth disabled → { enabled:false, hasWildcard:true, permissions:[] }.
  //     UI treats wildcard as "render everything."
  //   - Auth enabled but no Authorization header → 401 (caller should retry
  //     with a token).
  //   - Auth enabled + valid JWT → { roles, permissions, hasWildcard } where
  //     `permissions` excludes the '*' sentinel and `hasWildcard` is the
  //     boolean. Lets the UI distinguish "Admin (full access via *)" from
  //     "RoleMiner (these specific permissions)" for the badge display.
  app.get('/api/auth-me', authMiddleware, (req, res) => {
    if (!isAuthEnabled()) {
      return res.json({ enabled: false, hasWildcard: true, roles: [], permissions: [] });
    }
    const perms = req.user?.permissions || new Set();
    const hasWildcard = perms.has('*');
    res.json({
      enabled: true,
      roles: req.user?.roles || [],
      permissions: Array.from(perms).filter(p => p !== '*'),
      hasWildcard,
    });
  });

  // Everything below reads/writes the DB schema, so gate it while migrations run
  // (#696). Placed after the bootstrap endpoints above (which must stay 200) and
  // before every schema-dependent router, so a request during the migration
  // window gets a graceful 503 Retry-After instead of a raw 500 — and before the
  // ingest body parser, so a large crawler batch is rejected without being read.
  app.use('/api', schemaMigratingGate);

  // Performance metrics routes (auth-protected)
  app.use('/api', authMiddleware, perfRouter);

  // Auth middleware for all other API routes
  app.use('/api', authMiddleware, permissionsRouter);
  app.use('/api', authMiddleware, matrixRouter);
  app.use('/api', authMiddleware, effectiveAccessRouter);
  app.use('/api', authMiddleware, tagsRouter);
  app.use('/api', authMiddleware, categoriesRouter);
  app.use('/api', authMiddleware, detailsRouter);
  app.use('/api', authMiddleware, recentChangesRouter);
  app.use('/api', authMiddleware, riskRouter);
  app.use('/api', authMiddleware, orgChartRouter);
  app.use('/api', authMiddleware, identitiesRouter);
  app.use('/api', authMiddleware, preferencesRouter);
  app.use('/api', authMiddleware, systemsRouter);
  app.use('/api', authMiddleware, resourcesRouter);
  app.use('/api', authMiddleware, contextsRouter);
  // Context plugins (Admin → Contexts) — admin-only across the board.
  // Permission gates are applied PER ROUTE inside each router (not on the /api
  // mount) — a mount-level requirePermission on the shared '/api' prefix runs
  // for every admin request in mount order, so it would gate unrelated routers'
  // endpoints too. Per-route gates fire only when that router's route matches.
  app.use('/api', authMiddleware, contextPluginsRouter);
  app.use('/api/admin/import', express.json({ limit: '2mb' }));  // larger limit for import payloads
  // Role -> permission mapping (Admin → Authentication page). Gated per-route
  // by admin.auth inside the router so it's editable only by someone whose own
  // mapping already grants it.
  app.use('/api', authMiddleware, authRolesRouter);
  // adminRouter is a grab-bag of /admin/* endpoints with mixed permission needs
  // (read dashboards, write retention config, toggle feature flags, export curated
  // dumps, …). Gates are applied per-handler inside admin.js so each endpoint
  // requires the right permission.
  app.use('/api', authMiddleware, adminRouter);
  app.use('/api', authMiddleware, llmRouter);
  // Risk profile / classifier config is owned by the LLM admin — it drives how
  // risk-scoring prompts are built and which sources they cite. Gated per-route.
  app.use('/api', authMiddleware, riskProfilesRouter);
  // Listing existing runs is read-only; triggering one is admin. Per-handler in the router.
  app.use('/api', authMiddleware, riskScoringRunsRouter);
  app.use('/api', authMiddleware, accountLinkingRouter);
  app.use('/api', authMiddleware, crawlerFilesRouter);
  app.use('/api', authMiddleware, governanceRouter);
  // Bulk list endpoints used by Power Query / BI tools (read API keys honoured)
  app.use('/api', authMiddleware, bulkListsRouter);
  // Auto-update status/intent/log + the admin toggle (admin.systems gated writes)
  app.use('/api', authMiddleware, updatesRouter);
  // Read API token CRUD + Excel workbook download (admin-scoped). Per-handler
  // gates in the router separate "create your own token" (data.export.apikey)
  // from "list/revoke any token in tenant" (admin.read-tokens) and the workbook
  // download (data.export.ui).
  app.use('/api', authMiddleware, dataExportRouter);

  // ─── Crawler & job routes ───────────────────────────────────────
  // Admin crawler management (Entra ID auth) — /api/admin/crawlers/* — gated per-route.
  app.use('/api', authMiddleware, adminCrawlersRouter);
  // Crawler jobs (Entra ID auth) — /api/admin/crawler-jobs/*, /api/admin/status — gated per-route.
  app.use('/api', authMiddleware, jobsRouter);
  // Crawler self-service (API key auth) — /api/crawlers/whoami, /api/crawlers/rotate.
  // The worker data-plane (job claim/complete/phases/fail, ingest) is 503'd
  // mid-migration by the global schemaMigratingGate above; whoami/rotate are
  // allow-listed there so the worker can still authenticate and back off cleanly.
  app.use('/api', crawlerAuthMiddleware, selfServiceCrawlersRouter);
  // Ingest endpoints (API key auth) — /api/ingest/*
  // Ingest body size cap. Crawler chunks at 5,000 records per batch; with
  // extendedAttributes populated (SPs in particular carry appId, tags,
  // servicePrincipalNames, publisherName, etc.) a typical batch can reach
  // 20-30 MB. 50 MB gives ~5x headroom over real-world observed sizes while
  // still keeping a sane upper bound on memory use per request.
  app.use('/api/ingest', express.json({ limit: '50mb' }));
  app.use('/api', crawlerAuthMiddleware, ingestRouter);

  // In production, serve the frontend build output
  const frontendDist = process.env.FRONTEND_DIST || join(__dirname, '../../frontend/dist');
  app.use(express.static(frontendDist));
  app.get('*path', publicLimiter, (req, res, next) => {
    // Only serve index.html for non-API routes (SPA fallback)
    if (req.path.startsWith('/api')) return next();
    res.sendFile(join(frontendDist, 'index.html'));
  });

  return app;
}
