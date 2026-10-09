// Organisation truth — import profiles (owned by workstream T1).
//
//   GET  /api/org-truth/profiles               every profile version: the latest version of each name
//                                              first (isLatest: true), then the older ones; ?name= filters,
//                                              ?latest=1 returns only the newest version of each name
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
import { query, queryOne, tx } from '../../db/connection.js';
import { READ_GATE, WRITE_GATE } from './gates.js';
import {
  SOURCE_KINDS, validateRecipe, validateLinkRules, normalizeRecipe, normalizeLinkRules,
} from '../contracts.js';
import { PROFILE_COLUMNS, getProfile } from '../import/profileStore.js';
import { getSource } from '../import/sourceStore.js';
import { refreshProjections } from '../projection/refresh.js';
import { createImportRun, findActiveRun, startImportRun } from '../import/runImport.js';
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
  const latestOnly = ['1', 'true'].includes(req.query.latest);
  const r = await query(`
    SELECT * FROM (
      SELECT ${PROFILE_COLUMNS},
             ("version" = MAX("version") OVER (PARTITION BY "name")) AS "isLatest"
        FROM "OrgImportProfiles"
       WHERE ($1::text IS NULL OR "name" = $1)
    ) p
     WHERE (NOT $2::boolean OR p."isLatest")
     ORDER BY p."isLatest" DESC, p."name", p."version" DESC`, [name, latestOnly]);
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

// Change the link rules after the fact and link again, without a new upload:
//   POST /api/org-truth/profiles/:id/relink { linkRules } → 202 { profile, run }
// The rules are validated against the profile's recipe, saved as the next
// version of the profile (same recipe), and a DELTA run of that version starts
// on the source the profile's last run read — the entities stay, every rule is
// scored again, analyst overrides stay, links no rule produces any more are
// rejected (never deleted).
router.post('/org-truth/profiles/:id/relink', ...WRITE_GATE, handle('relink the profile', async (req, res) => {
  const current = await getProfile(req.params.id);
  if (!current) return res.status(404).json({ error: 'Profile not found.' });
  const { errors, value } = readProfileBody({ name: current.name, sourceKind: current.sourceKind, recipe: current.recipe, linkRules: req.body?.linkRules });
  if (errors) return sendInvalid(res, 'The link rules are not valid.', errors);
  const last = await queryOne(`
    SELECT r."sourceId" FROM "OrgImportRuns" r JOIN "OrgImportProfiles" p ON p.id = r."profileId"
     WHERE p.name = $1 ORDER BY r."createdAt" DESC LIMIT 1`, [current.name]);
  if (!last) return res.status(409).json({ error: 'This profile has not imported a source yet; run the import wizard first.' });
  const active = await findActiveRun(current.name);
  if (active) return res.status(409).json({ error: `Profile "${current.name}" already has a run in progress; wait for it to finish.`, runId: active.id });
  const profile = await queryOne(`
    INSERT INTO "OrgImportProfiles" ("id", "name", "version", "sourceKind", "recipe", "linkRules", "createdBy")
    SELECT $1, $2, COALESCE(MAX("version"), 0) + 1, $3, $4, $5, $6 FROM "OrgImportProfiles" WHERE "name" = $2
    RETURNING ${PROFILE_COLUMNS}`,
  [randomUUID(), current.name, value.sourceKind, JSON.stringify(value.recipe), JSON.stringify(value.linkRules), actorOf(req)]);
  const source = await getSource(last.sourceId);
  if (!source) return res.status(409).json({ error: 'The source of the last run no longer exists; upload the list again.' });
  const run = await createImportRun({ source, profile, mode: 'delta', triggeredBy: actorOf(req) });
  startImportRun(run.id);
  res.status(202).json({ profile, run });
}));

// Rename an entity type after the fact ("Uren" → "Urenregel", "FortigiTeam" → "Klant"):
//   POST /api/org-truth/profiles/:id/rename-type { from, to } → { profile, renamedEntities, otherProfiles }
// In one transaction: the profile's entities of that type (every version of the
// profile), the next profile version with the type renamed in its recipe and
// rules, and the next version of every OTHER profile whose rules point at the
// type (targetEntityType). The projection trees are rebuilt afterwards.
const TYPE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,63}$/u;

export function renameInRecipe(recipe, from, to) {
  return {
    ...recipe,
    entities: recipe.entities.map(e => (e.type === from ? { ...e, type: to } : e)),
    relations: (recipe.relations ?? []).map(r => ({ ...r, from: r.from === from ? to : r.from, to: r.to === from ? to : r.to })),
  };
}
export function renameInRules(rules, from, to) {
  return (rules ?? []).map(r => ({
    ...r,
    entityType: r.entityType === from ? to : r.entityType,
    ...(r.targetEntityType === from ? { targetEntityType: to } : {}),
    name: undefined,
  }));
}

async function insertVersion(client, current, recipe, rules, actor) {
  const linkRules = normalizeLinkRules(rules.map(({ name: _n, ...r }) => r));
  return (await client.query(`
    INSERT INTO "OrgImportProfiles" ("id", "name", "version", "sourceKind", "recipe", "linkRules", "createdBy")
    SELECT $1, $2, COALESCE(MAX("version"), 0) + 1, $3, $4, $5, $6 FROM "OrgImportProfiles" WHERE "name" = $2
    RETURNING ${PROFILE_COLUMNS}`,
  [randomUUID(), current.name, current.sourceKind, JSON.stringify(recipe), JSON.stringify(linkRules), actor])).rows[0];
}

router.post('/org-truth/profiles/:id/rename-type', ...WRITE_GATE, handle('rename the entity type', async (req, res) => {
  const current = await getProfile(req.params.id);
  if (!current) return res.status(404).json({ error: 'Profile not found.' });
  const from = String(req.body?.from ?? '').trim();
  const to = String(req.body?.to ?? '').trim();
  if (!current.recipe.entities.some(e => e.type === from)) return res.status(400).json({ error: `Profile "${current.name}" has no entity type "${from}".` });
  if (!TYPE_NAME.test(to)) return res.status(400).json({ error: 'The new name must start with a letter or digit and be at most 64 letters, digits, spaces, _ or -.' });
  if (to === from) return res.status(400).json({ error: 'The new name is the same as the old one.' });
  const taken = await queryOne(`SELECT 1 AS t FROM "OrgEntities" WHERE "entityType" = $1 LIMIT 1`, [to]);
  if (taken) return res.status(409).json({ error: `An entity type "${to}" already exists; pick another name.` });
  const actor = actorOf(req);
  const out = await tx(async (client) => {
    const renamed = await client.query(`
      UPDATE "OrgEntities" SET "entityType" = $1
       WHERE "entityType" = $2 AND "profileId" IN (SELECT id FROM "OrgImportProfiles" WHERE name = $3)`, [to, from, current.name]);
    const profile = await insertVersion(client, current, renameInRecipe(current.recipe, from, to), renameInRules(current.linkRules, from, to), actor);
    const others = (await client.query(`
      SELECT ${PROFILE_COLUMNS} FROM "OrgImportProfiles" p
       WHERE p.name <> $1 AND p.version = (SELECT MAX(v.version) FROM "OrgImportProfiles" v WHERE v.name = p.name)`, [current.name])).rows
      .filter(p => (p.linkRules ?? []).some(r => r.targetEntityType === from));
    for (const p of others) await insertVersion(client, p, p.recipe, renameInRules(p.linkRules, from, to), actor);
    return { profile, renamedEntities: renamed.rowCount ?? 0, otherProfiles: others.map(p => p.name) };
  });
  refreshProjections('type-rename').catch(err => console.error('org-truth: projection refresh after rename failed:', err.message));
  res.json(out);
}));

export default router;
