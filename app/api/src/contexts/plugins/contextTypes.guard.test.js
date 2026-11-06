// Guard: every contextType a plugin can write is in its `contextTypes`.
//
// The core ontology check (npm run ontology:check) compares each plugin's
// declared `contextTypes` with ontology/core.ttl. That only means something if
// the declaration is complete, so this scans the plugin sources for the
// contextType literals they emit — `contextType: 'X'`, and the rootType /
// childType defaults handed to the shared system-membership helper — and
// requires each one to be declared by a plugin. A value computed at run time
// (scope-hierarchy types nodes after their resourceType) cannot be found this
// way; such a plugin says so with contextTypesFromResourceType.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { REGISTERED_PLUGINS } from './registry.js';
import { CONTEXT_CATEGORIES } from '../../ingest/validation.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const LITERAL = /\b(?:contextType|rootType|childType)\s*:\s*'([^']+)'/g;

function pluginSources(dir = DIR) {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return pluginSources(full);
    return /\.js$/.test(name) && !/\.test\.js$/.test(name) ? [full] : [];
  });
}

function emittedLiterals() {
  const out = [];
  for (const file of pluginSources()) {
    for (const m of readFileSync(file, 'utf8').matchAll(LITERAL)) out.push({ value: m[1], file: relative(DIR, file).replace(/\\/g, '/') });
  }
  return out;
}

describe('context plugins declare the context types they emit', () => {
  it('every registered plugin declares a non-empty list of strings', () => {
    for (const p of REGISTERED_PLUGINS) {
      expect(Array.isArray(p.contextTypes) && p.contextTypes.length > 0, `${p.name} declares no contextTypes`).toBe(true);
      expect(p.contextTypes.every(t => typeof t === 'string' && t.length > 0), `${p.name} declares a non-string type`).toBe(true);
    }
  });

  it('every contextType literal in the plugin sources is declared', () => {
    const declared = new Set(REGISTERED_PLUGINS.flatMap(p => p.contextTypes));
    const found = emittedLiterals();
    // Guard against a vacuous pass: the scan must see the known emitters.
    expect(found.map(f => f.value)).toEqual(expect.arrayContaining(['OrganisationalUnit', 'EntraGroupCategory', 'SystemMembership']));
    const undeclared = found.filter(f => !declared.has(f.value)).map(f => `${f.file}: '${f.value}'`);
    expect(undeclared, 'add these to the emitting plugin\'s contextTypes (and to ontology/core.ttl)').toEqual([]);
  });

  it('every registered plugin declares a template, and none types nodes after a resourceType', () => {
    for (const p of REGISTERED_PLUGINS) expect(CONTEXT_CATEGORIES, `${p.name} declares template ${p.contextCategory}`).toContain(p.contextCategory);
    expect(REGISTERED_PLUGINS.filter(p => p.contextTypesFromResourceType)).toEqual([]);
  });
});
