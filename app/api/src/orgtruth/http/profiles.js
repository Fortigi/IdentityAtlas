// Organisation truth — import profiles (owned by workstream T1).
//
//   GET  /api/org-truth/profiles               every profile version: the latest version of each name
//                                              first (isLatest: true), then the older ones; ?name= filters
//   GET  /api/org-truth/profiles/:id           one version
//   POST /api/org-truth/profiles               create { name, sourceKind, recipe, linkRules } → version 1 (201)
//   PUT  /api/org-truth/profiles/:id           { sourceKind, recipe, linkRules } → a NEW version of that
//                                              profile's name (201); never edits a version in place
//
// Both writes validate with contracts.js (recipe without columns — the source
// is not known here — and the link rules against the recipe) and answer
// 400 { error, errors: [sentences] }. What is stored is the NORMALISED recipe
// and rules, so every reader can rely on the defaults (keyColumn, attribute
// names, thresholds).
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { query, queryOne } from '../../db/connection.js';
import { READ_GATE, WRITE_GATE } from './gates.js';
import {
  SOURCE_KINDS, validateRecipe, validateLinkRules, normalizeRecipe, normalizeLinkRules,
} from '../contracts.js';
import { PROFILE_COLUMNS, getProfile } from '../import/profileStore.js';
import { actorOf, handle, sendInvalid } from '../import/httpHelpers.js';

export const MAX_NAME_LENGTH = 200;
const router = Router();

// Returns { errors } (non-empty) or { value } ready to store.
export function readProfileBody(body) {
  const errors = [];
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name === '') errors.push('The profile needs a "name".');
  else if (name.length > MAX_NAME_LENGTH) errors.push(`The profile name is longer than ${MAX_NAME_LENGTH} characters.`);
  const sourceKind = body?.sourceKind ?? 'list';
  if (!SOURCE_KINDS.includes(sourceKind)) errors.push(`sourceKind "${sourceKind}" is not one of ${SOURCE_KINDS.join(', ')}.`);
  const linkRules = body?.linkRules ?? [];
  const recipeCheck = validateRecipe(body?.recipe);
  errors.push(...recipeCheck.errors, ...validateLinkRules(linkRules, body?.recipe).errors);
  if (errors.length > 0) return { errors };
  return { value: { name, sourceKind, recipe: normalizeRecipe(body.recipe), linkRules: normalizeLinkRules(linkRules) } };
}

const conflict = (res, name) => res.status(409).json({
  error: `A profile named "${name}" already exists; save a new version with PUT /api/org-truth/profiles/:id.`,
});
const isUniqueViolation = (err) => err?.code === '23505';

router.get('/org-truth/profiles', ...READ_GATE, handle('list the profiles', async (req, res) => {
  const name = typeof req.query.name === 'string' && req.query.name !== '' ? req.query.name : null;
  const r = await query(`
    SELECT ${PROFILE_COLUMNS},
           ("version" = MAX("version") OVER (PARTITION BY "name")) AS "isLatest"
      FROM "OrgImportProfiles"
     WHERE ($1::text IS NULL OR "name" = $1)
     ORDER BY "isLatest" DESC, "name", "version" DESC`, [name]);
  res.json(r.rows);
}));

router.get('/org-truth/profiles/:id', ...READ_GATE, handle('read the profile', async (req, res) => {
  const row = await getProfile(req.params.id);
  if (!row) return res.status(404).json({ error: 'Profile not found.' });
  res.json(row);
}));

router.post('/org-truth/profiles', ...WRITE_GATE, handle('save the profile', async (req, res) => {
  const { errors, value } = readProfileBody(req.body);
  if (errors) return sendInvalid(res, 'The profile is not valid.', errors);
  const taken = await queryOne(`SELECT 1 AS "taken" FROM "OrgImportProfiles" WHERE "name" = $1 LIMIT 1`, [value.name]);
  if (taken) return conflict(res, value.name);
  try {
    const row = await queryOne(`
      INSERT INTO "OrgImportProfiles" ("id", "name", "version", "sourceKind", "recipe", "linkRules", "createdBy")
      VALUES ($1, $2, 1, $3, $4, $5, $6)
      RETURNING ${PROFILE_COLUMNS}`,
    [randomUUID(), value.name, value.sourceKind, JSON.stringify(value.recipe), JSON.stringify(value.linkRules), actorOf(req)]);
    res.status(201).json(row);
  } catch (err) {
    if (isUniqueViolation(err)) return conflict(res, value.name);
    throw err;
  }
}));

router.put('/org-truth/profiles/:id', ...WRITE_GATE, handle('save the profile version', async (req, res) => {
  const current = await getProfile(req.params.id);
  if (!current) return res.status(404).json({ error: 'Profile not found.' });
  const { errors, value } = readProfileBody({ ...req.body, name: current.name });
  if (errors) return sendInvalid(res, 'The profile is not valid.', errors);
  try {
    const row = await queryOne(`
      INSERT INTO "OrgImportProfiles" ("id", "name", "version", "sourceKind", "recipe", "linkRules", "createdBy")
      SELECT $1, $2, COALESCE(MAX("version"), 0) + 1, $3, $4, $5, $6
        FROM "OrgImportProfiles" WHERE "name" = $2
      RETURNING ${PROFILE_COLUMNS}`,
    [randomUUID(), current.name, value.sourceKind, JSON.stringify(value.recipe), JSON.stringify(value.linkRules), actorOf(req)]);
    res.status(201).json(row);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    res.status(409).json({ error: 'Someone saved another version of this profile at the same moment; reload and try again.' });
  }
}));

export default router;
