// app-grouping-by-pattern plugin.
//
// Buckets resources by regex patterns over their display name. The analyst
// provides a list of { name, regex } pairs; each resource is matched top-to-
// bottom and assigned to the first regex that hits. Resources that match
// nothing go to a fallback bucket (configurable name, or dropped).
//
// Patterns are applied case-insensitively. Regex strings are compiled in the
// plugin, not in SQL, so there's no injection surface — but invalid regex is
// caught up front and produces a validation error.

import * as db from '../../db/connection.js';

/** @type {import('./types.js').ContextPlugin} */
export default {
  name: 'app-grouping-by-pattern',
  displayName: 'App Grouping (by pattern)',
  description: 'Groups resources into buckets by name regex. Useful for "all SharePoint sites", "all M365 groups for Finance", etc.',
  targetType: 'Resource',
  parametersSchema: {
    type: 'object',
    required: ['patterns'],
    properties: {
      scopeSystemId: { type: 'integer', description: 'Systems.id — limit to one system. Leave blank for all systems.' },
      patterns: {
        type: 'array',
        description: 'Ordered list of { name, regex } — first match wins.',
        items: {
          type: 'object',
          required: ['name', 'regex'],
          properties: {
            name:  { type: 'string', description: 'Bucket display name.' },
            regex: { type: 'string', description: 'JavaScript regex (no leading/trailing slash).' },
          },
        },
      },
      fallbackName: { type: 'string', default: '', description: 'Bucket name for resources that match nothing. Leave blank to skip.' },
    },
  },
  async run(params, ctx) {
    const scopeSystemId = params.scopeSystemId ? parseInt(params.scopeSystemId, 10) : null;
    const patterns = Array.isArray(params.patterns) ? params.patterns : [];
    const fallbackName = (params.fallbackName || '').trim();

    if (patterns.length === 0) {
      throw new Error('At least one pattern is required.');
    }

    const compiled = patterns.map((p, i) => {
      if (!p?.name || !p?.regex) throw new Error(`Pattern at index ${i} is missing name or regex.`);
      // Case-insensitivity is always applied (the 'i' flag below). Strip a
      // leading PCRE-style (?i) so users who paste a regex from grep / .NET
      // don't get "Invalid group" from the JS engine, which doesn't support
      // inline flag syntax.
      const source = String(p.regex).replace(/^\(\?i\)/, '');
      let re;
      try { re = new RegExp(source, 'i'); }
      catch (err) { throw new Error(`Pattern "${p.name}" has invalid regex: ${err.message}`); }
      return { name: String(p.name).slice(0, 500), re };
    });

    const rows = (await db.query(`
      SELECT id, "displayName"
        FROM "Resources"
       WHERE $1::int IS NULL OR "systemId" = $1
    `, [scopeSystemId])).rows;

    /** @type {Map<string, {externalId: string, displayName: string}>} */
    const bucketByName = new Map();
    const members = [];

    for (const r of rows) {
      const name = r.displayName || '';
      let bucketName = null;
      for (const p of compiled) {
        if (p.re.test(name)) { bucketName = p.name; break; }
      }
      if (!bucketName) {
        if (!fallbackName) continue;
        bucketName = fallbackName;
      }
      if (!bucketByName.has(bucketName)) {
        bucketByName.set(bucketName, { externalId: `bucket:${bucketName}`, displayName: bucketName });
      }
      members.push({ contextExternalId: `bucket:${bucketName}`, memberId: r.id });
    }

    const contexts = [...bucketByName.values()].map(b => ({
      externalId: b.externalId,
      displayName: b.displayName,
      contextType: 'AppGroup',
      parentExternalId: null,
    }));

    ctx.log?.(`Bucketed ${members.length} resources into ${contexts.length} groups.`);
    return { contexts, members };
  },
};
