// MCP tool: profile photos of accounts, as the app shows them on a person's
// detail page and in the header avatar.
//
// Each photo goes out twice: as an MCP image content block (a client that
// renders images shows the face) and as a data URI in structuredContent (an
// assistant that draws — an org chart, a slide — can place it). A photo is more
// than a name, so for a context owner it follows the detail-page rule: only
// people they may open in full (auth/ownerAccess), and always their own.

import { query } from '../../db/connection.js';
import { cleanIds } from '../../auth/ownerAccess/tiers.js';
import { toPhotoDataUri } from '../../auth/resolveMe.js';
import { errorResult } from '../result.js';
import { scopeOf } from '../ownerScope.js';

export const MAX_PHOTOS = 10;

// Which of `ids` this caller may see the photo of: everyone for a role-based
// reader; for a context owner, the accounts they may open plus their own.
export async function allowedPhotoIds(ids, ctx) {
  const owner = ctx?.user?.contextOwner;
  if (!owner) return new Set(ids);
  const allowed = await owner.access.accessibleIds('principal', ids);
  const me = (await ctx.caller())?.principalId;
  if (me && ids.includes(String(me).toLowerCase())) allowed.add(String(me).toLowerCase());
  return allowed;
}

export const getPhotos = {
  name: 'get_photos',
  title: 'Get profile photos',
  description:
    `The profile photos of up to ${MAX_PHOTOS} accounts, by account id (the "id" of a user or account row from `
    + 'run_query or search, or account.principalId from whoami). Returns each photo as an image and as a data URI '
    + '(for drawing an org chart or a card), and lists who has no photo. Use initials for those.',
  permission: 'data.read',
  // Scoped: a context owner gets photos only of people they may open, and their own.
  owner: 'scoped',
  inputSchema: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_PHOTOS },
    },
    required: ['ids'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const asked = Array.isArray(args?.ids) ? args.ids : [];
    if (asked.length === 0 || asked.length > MAX_PHOTOS) return errorResult(`ids must list 1 to ${MAX_PHOTOS} account ids.`);
    const ids = cleanIds(asked);
    const allowed = await allowedPhotoIds(ids, ctx);
    const readable = ids.filter(id => allowed.has(id));
    const { rows } = readable.length
      ? await query(
        `SELECT "id", "displayName", "photo", "photoContentType" FROM "Principals"
          WHERE "id" = ANY($1::uuid[]) AND "deletedAt" IS NULL ORDER BY "displayName"`,
        [readable],
      )
      : { rows: [] };
    const photos = [];
    const withoutPhoto = [];
    for (const r of rows) {
      const dataUri = toPhotoDataUri(r);
      if (dataUri) photos.push({ id: String(r.id).toLowerCase(), name: r.displayName, mimeType: r.photoContentType || 'image/jpeg', dataUri });
      else withoutPhoto.push({ id: String(r.id).toLowerCase(), name: r.displayName });
    }
    const found = new Set(rows.map(r => String(r.id).toLowerCase()));
    // Ids refused by the scope and ids that match no account read the same:
    // the caller learns nothing about an account they may not open.
    const notAvailable = asked.filter(a => !found.has(String(a).toLowerCase()));
    const payload = { scope: scopeOf(ctx), photos, withoutPhoto, notAvailable };
    return {
      structuredContent: payload,
      content: [
        { type: 'text', text: JSON.stringify({ ...payload, photos: photos.map(({ dataUri: _d, ...p }) => p) }) },
        ...photos.flatMap(p => [
          { type: 'text', text: `Photo of ${p.name} (${p.id})` },
          { type: 'image', data: p.dataUri.slice(p.dataUri.indexOf(',') + 1), mimeType: p.mimeType },
        ]),
      ],
      rowCount: photos.length,
    };
  },
};
