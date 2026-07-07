// Hard-rule guard: the renamed Entra-era resource types must never come back.
//
// resourceType is an OPEN vocabulary — every connected system names its own
// types (CSV / custom-connector / OData / Omada / midPoint / Azure supply
// arbitrary values), so (unlike assignmentType) it is NOT allow-listed and the
// retired literals are NOT named in production code (validation.js stays clean).
// Two renamed literals — EntraGroup -> Group, EntraRole -> EntraDirectoryRole
// (migration 052) — must never reappear. They are kept out by:
//   1. Source hygiene — the crawlers and fixtures (the emission sources) are
//      scanned here so a renamed literal can't be reintroduced at the source.
//   2. The DB — migration 054's CHECK rejects them on any write path.
// This test also pins resourceType as an OPEN field so a future allow-list enum
// (which would break CSV/Omada/midPoint/Azure imports) can't be slipped in.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { validateRecords } from './validation.js';

// The renamed literals (migration 052). Named only here (a test) and in the
// migration — never in production application code.
const RETIRED = ['EntraGroup', 'EntraRole'];
// A representative slice of the OPEN vocabulary that must keep validating: Entra's
// own types plus types other systems emit (Azure / Omada / midPoint / CSV) that
// are deliberately not in any allow-list.
const OPEN_VOCAB = [
  'Group', 'EntraDirectoryRole', 'BusinessRole', 'Application', 'AppRole',
  'DelegatedPermission', 'GroupOwnership', 'ServicePrincipalOwnership',
  'ApplicationOwnership', 'AzureRoleAssignment', 'Service', 'Entitlement', 'SAPRole',
];

const R = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const P = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const resRec = (resourceType) => [{ displayName: 'r', resourceType }];
const asgnRec = (resourceType) => [{ resourceId: R, principalId: P, assignmentType: 'Direct', resourceType }];
const idRec = (resourceType) => [{ resourceId: R, identityId: P, assignmentType: 'Direct', resourceType }];

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCAN_ROOTS = ['tools/crawlers', 'test/demo-dataset', 'test/benchmark'].map(r => join(repoRoot, r));

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'results') out.push(...walk(p)); }
    else out.push(p);
  }
  return out;
}

describe('resource-type hard rule — stays an open vocabulary', () => {
  it('ingest accepts the open vocabulary on resources and both assignment shapes', () => {
    // If someone turns resourceType into an allow-list enum (as assignmentType
    // is), these system-specific types would start failing — that's the mistake
    // this test blocks. resourceType must remain open.
    for (const rt of OPEN_VOCAB) {
      expect(validateRecords(resRec(rt), 'resources').valid, `${rt} (resources) should validate`).toBe(true);
      expect(validateRecords(asgnRec(rt), 'resource-assignments').valid, `${rt} (assignment) should validate`).toBe(true);
      expect(validateRecords(idRec(rt), 'resource-assignments-identity').valid, `${rt} (identity) should validate`).toBe(true);
    }
  });
});

describe('resource-type hard rule — static emission scan', () => {
  it('no crawler or fixture emits a retired resourceType', () => {
    // Match an emission (resourceType = 'X' / "resourceType": "X"), not a
    // comparison or comment. Longer variant first; the closing-quote anchor
    // keeps EntraDirectoryRole from matching the EntraRole alternative.
    const alternation = [...RETIRED].sort((a, b) => b.length - a.length).join('|');
    const emitRe = new RegExp(`["']?resourceType["']?\\s*[=:]\\s*['"](${alternation})['"]`);
    const files = SCAN_ROOTS.flatMap(walk).filter(f => /\.(ps1|js|jsx|json)$/.test(f) && !/\.test\./.test(f));
    const offenders = [];
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (emitRe.test(line)) offenders.push(`${f.replace(/\\/g, '/').split(/\/(tools|test)\//)[2]}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders, `retired resourceType emitted:\n${offenders.join('\n')}`).toEqual([]);
  });
});
