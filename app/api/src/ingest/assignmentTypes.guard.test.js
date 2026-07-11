// Hard-rule guard for the assignment-model redesign.
//
// An assignment is only ever one of the three universal "how" values
// (Direct / Indirect / Eligible). Everything that used to be its own
// assignmentType is now modelled differently — ownership is a Direct membership
// on a GroupOwnership resource, governance is the `governed` flag, and the old
// source-attribute types collapse to Direct/Indirect/Eligible + resourceType.
//
// Two layers keep the model from drifting back to ten types:
//   1. Runtime  — ingest validation accepts ONLY the three values.
//   2. Static   — the crawlers (the emission sources) are scanned so a retired
//                 type can't be reintroduced at the source.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { validateRecords } from './validation.js';

const ALLOWED = ['Direct', 'Indirect', 'Eligible'];
// Single source of truth: every assignmentType token the model has ever had.
// RETIRED is DERIVED (known-ever minus the accepted set) so the two lists can't
// drift — add a new type to ALLOWED and it automatically drops out of RETIRED,
// retire one by leaving it here and out of ALLOWED. The static-scan regex below
// is also built from RETIRED, so there is nothing to hand-sync.
const KNOWN_EVER = [...ALLOWED, 'Owner', 'Governed', 'OAuth2Grant', 'AppRole', 'AppRoleViaGroup', 'DirectoryRole', 'DirectoryRoleEligible'];
const RETIRED = KNOWN_EVER.filter(t => !ALLOWED.includes(t));

const R = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const P = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const rec = (assignmentType) => [{ resourceId: R, principalId: P, assignmentType }];

// Every place that emits assignmentType records into the ingest: the crawlers
// and the test fixtures/seeders (the demo dataset + benchmark, which feed the
// same ingest API and would be rejected by the narrowed validation).
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

describe('assignment-type hard rule — runtime', () => {
  it('accepts the three universal types', () => {
    for (const t of ALLOWED) {
      expect(validateRecords(rec(t), 'resource-assignments').valid, `${t} should validate`).toBe(true);
    }
  });

  it('rejects every retired assignmentType', () => {
    for (const t of RETIRED) {
      expect(validateRecords(rec(t), 'resource-assignments').valid, `${t} must be rejected`).toBe(false);
      expect(validateRecords(rec(t), 'resource-assignments-identity').valid, `${t} (identity) must be rejected`).toBe(false);
    }
  });
});

describe('assignment-type hard rule — static emission scan', () => {
  it('no crawler or fixture emits a retired assignmentType', () => {
    // Match an emission (assignmentType = 'X' / "assignmentType": "X"), not a
    // comparison/comment/phase-toggle name, so historical handling and
    // SyncOAuth2Grants-style params don't trip it. The alternation is built
    // from RETIRED (no hand-synced literal); longer variants first so the
    // closing-quote anchor resolves AppRole vs AppRoleViaGroup correctly.
    const alternation = [...RETIRED].sort((a, b) => b.length - a.length).join('|');
    const emitRe = new RegExp(`["']?assignmentType["']?\\s*[=:]\\s*['"](${alternation})['"]`);
    const files = SCAN_ROOTS.flatMap(walk).filter(f => /\.(ps1|js|jsx|json)$/.test(f) && !/\.test\./.test(f));
    const offenders = [];
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (emitRe.test(line)) offenders.push(`${f.replace(/\\/g, '/').split(/\/(tools|test)\//)[2]}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders, `retired assignmentType emitted:\n${offenders.join('\n')}`).toEqual([]);
  });
});
