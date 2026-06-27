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
const RETIRED = ['Owner', 'Governed', 'OAuth2Grant', 'AppRole', 'AppRoleViaGroup', 'DirectoryRole', 'DirectoryRoleEligible'];

const R = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const P = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const rec = (assignmentType) => [{ resourceId: R, principalId: P, assignmentType }];

const crawlersDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'tools', 'crawlers');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
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

describe('assignment-type hard rule — static crawler scan', () => {
  it('no crawler emits a retired assignmentType', () => {
    // Match an emission (assignmentType = 'X' / assignmentType: 'X'), not a
    // comparison/comment/phase-toggle name, so historical handling and
    // SyncOAuth2Grants-style params don't trip it.
    const emitRe = new RegExp(`assignmentType\\s*[=:]\\s*['"](${RETIRED.join('|')})['"]`);
    const files = walk(crawlersDir).filter(f => /\.(ps1|js|jsx)$/.test(f) && !/\.test\./.test(f));
    const offenders = [];
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (emitRe.test(line)) offenders.push(`${f.replace(/\\/g, '/').split('/tools/')[1]}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders, `retired assignmentType emitted by a crawler:\n${offenders.join('\n')}`).toEqual([]);
  });
});
