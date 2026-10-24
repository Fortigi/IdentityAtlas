// The ownership vocabulary is one list because two consumers filter on it and a
// third crawler now writes it. These tests pin the two things that actually go
// wrong: a type quietly dropping out of the list (which turns owners back into
// members in the risk engine), and the SQL rendering being something an `IN`
// clause cannot take.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  OWNERSHIP_RESOURCE_TYPES, OWNERSHIP_RELATIONSHIP_TYPES,
  OWNERSHIP_TYPES_SQL, OWNERSHIP_RELATIONSHIP_TYPES_SQL, sqlInList,
} from './ownershipTypes.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

describe('ownership vocabulary', () => {
  it('names every ownership type a crawler emits', () => {
    // Each of these is written by a shipped crawler; dropping one from the list
    // does not fail anything loudly — it silently counts owners as members.
    expect(OWNERSHIP_RESOURCE_TYPES).toEqual(expect.arrayContaining([
      'GroupOwnership',            // Entra group owners
      'ServicePrincipalOwnership', // Entra enterprise-app owners
      'ApplicationOwnership',      // Entra app-registration owners
      'ResourceOwnership',         // SQL connector, any owned resourceType
    ]));
  });

  it('has no duplicates and no blank entries', () => {
    for (const list of [OWNERSHIP_RESOURCE_TYPES, OWNERSHIP_RELATIONSHIP_TYPES]) {
      expect(new Set(list).size).toBe(list.length);
      expect(list.every(v => typeof v === 'string' && v.trim().length > 0)).toBe(true);
    }
  });

  it('covers both relationship spellings — HasAppOwnership is the same edge', () => {
    // HasAppOwnership exists only so the Entra group-owner full sync cannot
    // reconcile the app-owner links away. A traversal that reads one and not
    // the other loses half the owners.
    expect(OWNERSHIP_RELATIONSHIP_TYPES).toEqual(['HasOwnership', 'HasAppOwnership']);
  });

  it('renders a parenthesised, quoted, comma-joined IN list', () => {
    expect(sqlInList(['A', 'B'])).toBe("('A','B')");
    expect(OWNERSHIP_TYPES_SQL.startsWith('(')).toBe(true);
    expect(OWNERSHIP_TYPES_SQL.endsWith(')')).toBe(true);
    for (const t of OWNERSHIP_RESOURCE_TYPES) expect(OWNERSHIP_TYPES_SQL).toContain(`'${t}'`);
    expect(OWNERSHIP_RELATIONSHIP_TYPES_SQL).toBe("('HasOwnership','HasAppOwnership')");
  });

  it('is what the SQL connector actually emits', () => {
    // The crawler is PowerShell and cannot import this module, so the two would
    // drift the first time either is renamed. Read the literal it emits.
    const ps = readFileSync(join(repoRoot, 'tools/crawlers/mssql/SqlCrawler.Ownership.ps1'), 'utf8');
    const type = /\$script:SqlOwnershipResourceType\s*=\s*'([^']+)'/.exec(ps);
    const rel = /\$script:SqlOwnershipRelationship\s*=\s*'([^']+)'/.exec(ps);
    expect(OWNERSHIP_RESOURCE_TYPES).toContain(type[1]);
    expect(OWNERSHIP_RELATIONSHIP_TYPES).toContain(rel[1]);
  });
});

describe('the consumers read the shared list, not their own copy', () => {
  // Both of these held their own hardcoded literal before, and the risk
  // engine's named exactly one of the three types its own comment described.
  it.each([
    'app/api/src/riskscoring/engine.js',
    'app/api/src/nlreports/catalog.js',
  ])('%s has no inline ownership-type list left', (file) => {
    const src = readFileSync(join(repoRoot, file), 'utf8');
    expect(src).toContain("from '../lib/ownershipTypes.js'");
    expect(src).not.toMatch(/'GroupOwnership'/);
    expect(src).not.toMatch(/'HasAppOwnership'/);
  });
});
