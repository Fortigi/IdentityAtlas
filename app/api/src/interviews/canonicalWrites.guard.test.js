// Hard-rule guard: the interview code writes ONLY to its own Interview* tables.
//
// The handover's non-negotiable is "no automatic governance writes": an interview may
// propose, an analyst may approve, but nothing in this slice promotes a claim into
// Resources, assignments, identities or contexts. The route tests prove it for the
// paths they exercise; this scan proves it for every statement in the source, including
// the ones no test reaches. Promotion, when it is built, belongs in its own module with
// its own review — and this guard is the place that forces that conversation.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

function sources(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sources(full);
    return entry.endsWith('.js') && !entry.includes('.test.') ? [full] : [];
  });
}

const files = [...sources(here), join(here, '..', 'routes', 'interviews.js')];
// Upper case only: the repo writes SQL keywords in capitals, and prose ("an update to")
// would otherwise count.
const WRITE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE|MERGE\s+INTO)\s+"?(\w+)"?/g;

describe('interview code writes only to Interview* tables', () => {
  it('finds the store modules (an empty scan would pass vacuously)', () => {
    const names = files.map(f => relative(here, f).split('\\').join('/'));
    expect(names).toEqual(expect.arrayContaining(['store.js', 'claims.js', 'http/sessions.js', '../routes/interviews.js']));
  });

  it('every INSERT / UPDATE / DELETE targets an Interview* table', () => {
    const offenders = [];
    let writes = 0;
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(WRITE)) {
        writes++;
        if (!/^Interview/.test(m[2])) offenders.push(`${relative(here, f)}: ${m[0]}`);
      }
    }
    // The store does write — if this drops to zero the regex stopped matching.
    expect(writes).toBeGreaterThanOrEqual(8);
    expect(offenders).toEqual([]);
  });
});
