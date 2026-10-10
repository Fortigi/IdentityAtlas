// Analytics API v1 — Analytics Profiles and jointly aggregated datasets for
// Power BI (docs/architecture/analytics-profiles.md).
//
// Every route needs the `analytics` feature (404 when off). Gates are applied
// per route, permission first, so a caller without the permission gets 403
// whether or not the feature is on.
//
//   read  (any mapped permission, or an fgr_ read token; GET only):
//     GET  /api/analytics/v1/catalog
//     GET  /api/analytics/v1/profiles
//     GET  /api/analytics/v1/profiles/:id
//     GET  /api/analytics/v1/profiles/:id/versions
//     GET  /api/analytics/v1/profiles/:id/metadata
//     GET  /api/analytics/v1/profiles/:id/datasets/:datasetId
//   configure (admin.analytics):
//     POST   /api/analytics/v1/profiles/validate
//     POST   /api/analytics/v1/profiles
//     PUT    /api/analytics/v1/profiles/:id        body carries expectedVersion
//     DELETE /api/analytics/v1/profiles/:id        retires (a new version), never deletes
//
// The data endpoints are read-only and live outside /api/admin/ on purpose:
// read tokens are refused on any /api/admin/ path and on any non-GET.

import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import { requireFeature } from '../featureFlags.js';
import { ALL_PERMISSION_KEYS } from '../auth/permissions.js';
import { listFields } from '../analytics/fields.js';
import { describeMetrics } from '../analytics/metrics.js';
import { validateProfileInput, LIMITS } from '../analytics/profileSchema.js';
import { checkAgainstData } from '../analytics/profileChecks.js';
import {
  listProfiles, getProfile, listVersions, createProfile, updateProfile,
} from '../analytics/profileStore.js';
import { runDataset, API_VERSION } from '../analytics/aggregator.js';
import { profileMetadata } from '../analytics/metadata.js';
import { AnalyticsError } from '../analytics/shaping.js';

const router = Router();
const BASE = '/analytics/v1';

// Reads: any mapped permission (the Dashboard's gate, SEC-2026-09 M-01) — so a
// signed-in user whose roles map to nothing is refused — and fgr_ read tokens,
// which carry data.read.
const readGate = [requirePermission(...ALL_PERMISSION_KEYS), requireFeature('analytics')];
const configureGate = [requirePermission('admin.analytics'), requireFeature('analytics')];

function actorOf(req) {
  return (req.user && (req.user.email || req.user.preferred_username || req.user.upn || req.user.name)) || 'unknown';
}

function fail(res, route, err) {
  if (err instanceof AnalyticsError) {
    return res.status(err.status).json({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
  }
  console.error(`analytics ${route} failed:`, err.message);
  return res.status(500).json({ error: 'Request failed', code: 'internal' });
}

const invalid = (res, errors, warnings) =>
  res.status(400).json({ error: 'The profile is not valid.', code: 'invalid_profile', details: { errors, warnings } });

// Shape validation, then the database checks. Returns { profile, warnings, preview } or sends 400.
async function validated(req, res) {
  const shape = validateProfileInput(req.body);
  if (shape.errors.length) { invalid(res, shape.errors, []); return null; }
  const data = await checkAgainstData(shape.profile.definition);
  if (data.errors.length) { invalid(res, data.errors, data.warnings); return null; }
  return { profile: shape.profile, warnings: data.warnings, preview: data.preview };
}

async function loadOr404(req) {
  const profile = await getProfile(req.params.id);
  if (!profile) throw new AnalyticsError(404, 'not_found', 'No such profile.');
  return profile;
}

router.get(`${BASE}/catalog`, readGate, async (_req, res) => {
  try {
    res.json({ apiVersion: API_VERSION, limits: LIMITS, metrics: describeMetrics(), fields: await listFields() });
  } catch (err) { fail(res, 'catalog', err); }
});

router.get(`${BASE}/profiles`, readGate, async (_req, res) => {
  try {
    res.json({ apiVersion: API_VERSION, data: await listProfiles() });
  } catch (err) { fail(res, 'list', err); }
});

router.post(`${BASE}/profiles/validate`, configureGate, async (req, res) => {
  try {
    const ok = await validated(req, res);
    if (ok) res.json({ valid: true, warnings: ok.warnings, preview: ok.preview, definition: ok.profile.definition });
  } catch (err) { fail(res, 'validate', err); }
});

router.post(`${BASE}/profiles`, configureGate, async (req, res) => {
  try {
    const ok = await validated(req, res);
    if (!ok) return;
    const row = await createProfile(ok.profile, actorOf(req));
    res.status(201).json({ ...row, warnings: ok.warnings, preview: ok.preview });
  } catch (err) { fail(res, 'create', err); }
});

router.get(`${BASE}/profiles/:id`, readGate, async (req, res) => {
  try {
    res.json(await loadOr404(req));
  } catch (err) { fail(res, 'get', err); }
});

router.get(`${BASE}/profiles/:id/versions`, readGate, async (req, res) => {
  try {
    await loadOr404(req);
    res.json({ data: await listVersions(req.params.id) });
  } catch (err) { fail(res, 'versions', err); }
});

router.put(`${BASE}/profiles/:id`, configureGate, async (req, res) => {
  try {
    const expectedVersion = req.body?.expectedVersion;
    if (!Number.isInteger(expectedVersion)) {
      return res.status(400).json({ error: 'expectedVersion (the version you edited) is required.', code: 'invalid_profile' });
    }
    const ok = await validated(req, res);
    if (!ok) return;
    const row = await updateProfile(req.params.id, ok.profile, expectedVersion, actorOf(req));
    res.json({ ...row, warnings: ok.warnings, preview: ok.preview });
  } catch (err) { fail(res, 'update', err); }
});

router.delete(`${BASE}/profiles/:id`, configureGate, async (req, res) => {
  try {
    const current = await loadOr404(req);
    if (current.status === 'retired') return res.json(current);
    const retired = { name: current.name, description: current.description, status: 'retired', definition: current.definition };
    res.json(await updateProfile(current.id, retired, current.version, actorOf(req)));
  } catch (err) { fail(res, 'retire', err); }
});

router.get(`${BASE}/profiles/:id/metadata`, readGate, async (req, res) => {
  try {
    res.json(profileMetadata(await loadOr404(req)));
  } catch (err) { fail(res, 'metadata', err); }
});

router.get(`${BASE}/profiles/:id/datasets/:datasetId`, readGate, async (req, res) => {
  try {
    const profile = await loadOr404(req);
    const out = await runDataset(profile, req.params.datasetId);
    // Aggregates can still describe people: record who pulled what, and when.
    const who = req.readToken ? `read token "${req.readToken.name}"` : actorOf(req);
    console.log(`analytics: ${who} read dataset ${out.dataset.id} of profile ${profile.id} v${profile.version} (${out.rowCount} rows)`);
    res.set('Cache-Control', 'no-store');
    res.json(out);
  } catch (err) { fail(res, 'dataset', err); }
});

export default router;
