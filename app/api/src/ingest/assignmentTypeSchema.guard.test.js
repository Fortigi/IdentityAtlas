import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Static guard: every `assignmentType` schema field in validation.js must be
// constrained to `enum: ASSIGNMENT_TYPES` (the three universal values). A NEW
// ingest schema — or a future edit — that declared assignmentType as free text
// (or with a drifted enum) would let a retired type (Owner/Governed/…) back in
// via that endpoint. Scanning the source keeps the internal SCHEMAS object
// un-exported. Complements assignmentTypes.guard.test.js (runtime rejection +
// crawler emission scan).
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'validation.js'), 'utf8');

// Each field definition looks like:
//   assignmentType: { type: 'string', enum: ASSIGNMENT_TYPES },
const defs = [...src.matchAll(/assignmentType\s*:\s*\{([^}]*)\}/g)].map((m) => m[1]);

describe('assignmentType schema fields are enum-constrained', () => {
  it('validation.js declares assignmentType on at least the two assignment schemas', () => {
    expect(defs.length).toBeGreaterThanOrEqual(2);
  });

  it('every assignmentType schema field constrains it to enum: ASSIGNMENT_TYPES', () => {
    const offenders = defs.filter((body) => !/enum\s*:\s*ASSIGNMENT_TYPES\b/.test(body));
    expect(
      offenders,
      `an assignmentType schema field is not constrained to ASSIGNMENT_TYPES ` +
      `(free text or a drifted enum would let a retired type in):\n${offenders.join('\n---\n')}`,
    ).toEqual([]);
  });

  it('ASSIGNMENT_TYPES is exactly the three universal values', () => {
    expect(src).toMatch(/const ASSIGNMENT_TYPES\s*=\s*\[\s*'Direct',\s*'Indirect',\s*'Eligible'\s*\]/);
  });
});
