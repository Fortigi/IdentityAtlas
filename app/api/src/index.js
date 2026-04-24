import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { authMiddleware } from './middleware/auth.js';
import { perfMetrics } from './middleware/perfMetrics.js';
import { enable as enablePerf, isEnabled as isPerfEnabled } from './perf/collector.js';
import permissionsRouter from './routes/permissions.js';
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
import llmRouter from './routes/llm.js';
import riskProfilesRouter from './routes/riskProfiles.js';
import riskScoringRunsRouter from './routes/riskScoringRuns.js';
import correlationRulesetsRouter from './routes/correlationRulesets.js';
import { adminCrawlersRouter, selfServiceCrawlersRouter } from './routes/crawlers.js';
import { crawlerAuthMiddleware } from './middleware/crawlerAuth.js';
import ingestRouter from './routes/ingest.js';
import jobsRouter from './routes/jobs.js';
import csvUploadsRouter from './routes/csvUploads.js';
import dataExportRouter from './routes/dataExport.js';
import bulkListsRouter from './routes/bulkLists.js';
import { loadAuthConfig, isAuthEnabled, getTenantId, getClientId } from './config/authConfig.js';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import { join as pathJoin } from 'path';
import { bootstrapWorker } from './bootstrap.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';
// Note: authentication state is now dynamic — read it via isAuthEnabled() which
// reflects the current value from authConfig.js (DB-backed, hot-reloadable).
// The local authEnabled below is a startup snapshot used only for the boot warning.
const authEnabledAtBoot = process.env.AUTH_ENABLED === 'true';
// Performance monitoring is ON by default — opt-out by setting PERF_METRICS_ENABLED=false.
// The runtime toggle in the Performance page still works to enable/disable per session.
const perfEnabled = process.env.PERF_METRICS_ENABLED !== 'false';

// Resolve module version: env var (set during deployment) → fallback to .psd1 manifest
let moduleVersion = process.env.MODULE_VERSION || null;
if (!moduleVersion) {
  // Try to read the version from the .psd1 manifest. Two paths:
  //   1. /app/setup/IdentityAtlas.psd1 — mounted by docker-compose.yml for local dev
  //   2. ../../../setup/IdentityAtlas.psd1 — works when running outside Docker (e.g. npm start)
  const candidates = [
    '/app/setup/IdentityAtlas.psd1',
    join(__dirname, '../../../setup/IdentityAtlas.psd1'),
  ];
  for (const p of candidates) {
    try {
      const content = readFileSync(p, 'utf-8');
      const match = content.match(/ModuleVersion\s*=\s*'([^']+)'/);
      if (match) { moduleVersion = match[1]; break; }
    } catch { /* not available at this path */ }
  }
}

// ─── Performance metrics (opt-in via PERF_METRICS_ENABLED=true) ─
if (perfEnabled) {
  enablePerf();
}

// ─── Startup env validation ──────────────────────────────────────
if (isProduction && !authEnabledAtBoot) {
  console.warn('WARNING: AUTH_ENABLED is not set to "true" in production. All API endpoints are unauthenticated until configured via Admin → Authentication.');
}

// Load auth config from DB (with env var fallback). Best-effort — if the DB
// isn't reachable yet at startup we'll fall back to env vars and the admin
// page can flip things on later.
loadAuthConfig().catch(err => {
  console.warn('Initial auth config load failed:', err.message);
});

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
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : isProduction
      ? false  // Disallow cross-origin in production if not explicitly configured
      : true,  // Allow all origins in development
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
  const openapiSpec = YAML.load(pathJoin(__dirname, 'openapi.yaml'));
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

// Unauthenticated endpoints (rate-limited)
app.get('/api/health', publicLimiter, (req, res) => {
  res.json({ status: 'ok' });
});

// Minimum compose file version this image expects. Bump this whenever
// docker-compose.prod.yml changes in a way that affects runtime behavior
// (new env vars, volume mounts, group_add, etc.). Users with an older
// compose file will see a warning on the Dashboard.
const MIN_COMPOSE_FILE_VERSION = 1;

app.get('/api/version', publicLimiter, (req, res) => {
  const composeFileVersion = parseInt(process.env.COMPOSE_FILE_VERSION || '0', 10);
  res.json({
    version: moduleVersion || null,
    composeFileVersion: composeFileVersion || null,
    minComposeFileVersion: MIN_COMPOSE_FILE_VERSION,
    composeFileOutdated: composeFileVersion > 0 && composeFileVersion < MIN_COMPOSE_FILE_VERSION,
  });
});

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

app.get('/api/features', publicLimiter, async (req, res) => {
  // WorkerConfig overrides win over env vars; env vars are the fallback default.
  // Risk Scoring defaults to OFF on a fresh install — opt-in via the toggle
  // in Admin → Risk Scoring or via FEATURE_RISK_SCORING=true.
  const riskOverride = await getFeatureOverride('RISK_SCORING');
  const corrOverride = await getFeatureOverride('ACCOUNT_CORRELATION');
  res.json({
    riskScoring: riskOverride !== null
      ? riskOverride
      : process.env.FEATURE_RISK_SCORING === 'true',
    accountCorrelation: corrOverride !== null
      ? corrOverride
      : process.env.FEATURE_ACCOUNT_CORRELATION !== 'false',
  });
});

app.get('/api/auth-config', publicLimiter, (req, res) => {
  // Reads the live config from authConfig.js so a UI-driven save takes effect
  // immediately for any new browser session.
  if (!isAuthEnabled()) {
    return res.json({ enabled: false });
  }
  res.json({
    enabled: true,
    clientId: getClientId(),
    tenantId: getTenantId(),
  });
});

// Performance metrics routes (auth-protected)
app.use('/api', authMiddleware, perfRouter);

// Auth middleware for all other API routes
app.use('/api', authMiddleware, permissionsRouter);
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
app.use('/api', authMiddleware, contextPluginsRouter);
app.use('/api/admin/import', express.json({ limit: '2mb' }));  // larger limit for import payloads
app.use('/api', authMiddleware, adminRouter);
app.use('/api', authMiddleware, llmRouter);
app.use('/api', authMiddleware, riskProfilesRouter);
app.use('/api', authMiddleware, riskScoringRunsRouter);
app.use('/api', authMiddleware, correlationRulesetsRouter);
app.use('/api', authMiddleware, csvUploadsRouter);
app.use('/api', authMiddleware, governanceRouter);
// Bulk list endpoints used by Power Query / BI tools (read API keys honoured)
app.use('/api', authMiddleware, bulkListsRouter);
// Read API token CRUD + Excel workbook download (admin-scoped)
app.use('/api', authMiddleware, dataExportRouter);

// ─── Crawler & job routes ───────────────────────────────────────
// Admin crawler management (Entra ID auth) — /api/admin/crawlers/*
app.use('/api', authMiddleware, adminCrawlersRouter);
// Crawler jobs (Entra ID auth) — /api/admin/crawler-jobs/*, /api/admin/status
app.use('/api', authMiddleware, jobsRouter);
// Crawler self-service (API key auth) — /api/crawlers/whoami, /api/crawlers/rotate
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
const frontendDist = join(__dirname, '../../frontend/dist');
app.use(express.static(frontendDist));
app.get('*', (req, res, next) => {
  // Only serve index.html for non-API routes (SPA fallback)
  if (req.path.startsWith('/api')) return next();
  res.sendFile(join(frontendDist, 'index.html'));
});

const server = app.listen(port, async () => {
  console.log(`Identity Atlas running on http://localhost:${port}`);
  console.log(`Mode: ${process.env.USE_SQL === 'true' ? 'SQL' : 'Mock data'}`);
  console.log(`Auth: ${isAuthEnabled() ? 'Entra ID' : 'Disabled'}`);
  console.log(`Perf: ${isPerfEnabled() ? 'Enabled (Server-Timing headers + /api/perf)' : 'Disabled'}`);

  // Auto-create built-in worker crawler + infrastructure tables
  await bootstrapWorker();
});

// Graceful shutdown: close SQL pool before exiting
async function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  server.close(async () => {
    if (process.env.USE_SQL === 'true') {
      const { closePool } = await import('./db/connection.js');
      await closePool();
    }
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
