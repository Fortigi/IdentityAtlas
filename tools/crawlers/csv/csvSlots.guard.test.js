/**
 * Guard: csv-slots.json must agree with the crawler's own declarations.
 *
 * Two facts about each schema slot exist on both sides of the language boundary:
 * the file's column list (schema/*.csv, which csvMapping.js reads directly — no
 * copy to guard) and whether its target table keeps extra columns as
 * extendedAttributes (CSVCrawler.Transform.ps1's $CsvReservedColumns vs
 * $CsvUnkeptColumnsSchema). The wizard cannot import PowerShell, so
 * `keepsExtraColumns` in csv-slots.json is a copy — and this test fails when it
 * disagrees with the crawler, naming the file, per CLAUDE.md's "declare once —
 * derive or guard every copy".
 *
 * The symptom it prevents is a quiet one: the mapping panel telling an admin
 * their unmapped columns are "kept as extended attributes" for a file whose
 * crawler drops them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import CSV_SLOTS from './csv-slots.json';
import { schemaColumnsFor } from './csvMapping.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRANSFORM = readFileSync(join(HERE, 'CSVCrawler.Transform.ps1'), 'utf8');

// The file names listed in one of the crawler's two PowerShell schema tables.
function filesInTable(name) {
  const block = TRANSFORM.split(`$script:${name} = @{`)[1];
  expect(block, `${name} not found in CSVCrawler.Transform.ps1`).toBeTruthy();
  const body = block.split(/^\}/m)[0];
  return new Set([...body.matchAll(/^\s*'([^']+\.csv)'\s*=/gm)].map(m => m[1]));
}

describe('csv-slots.json agrees with the crawler', () => {
  const keepsExtras = filesInTable('CsvReservedColumns');
  const dropsExtras = filesInTable('CsvUnkeptColumnsSchema');

  it('declares keepsExtraColumns exactly for the files whose extras the crawler drops', () => {
    const declaredDrop = CSV_SLOTS.filter(s => s.keepsExtraColumns === false).map(s => s.file).sort();
    expect(declaredDrop).toEqual([...dropsExtras].sort());
  });

  it('leaves keepsExtraColumns unset for every file the crawler does keep extras for', () => {
    const declaredKeep = CSV_SLOTS.filter(s => s.keepsExtraColumns !== false).map(s => s.file).sort();
    expect(declaredKeep).toEqual([...keepsExtras].sort());
  });

  it('covers every slot in exactly one of the two tables', () => {
    const uncovered = CSV_SLOTS.filter(s => !keepsExtras.has(s.file) && !dropsExtras.has(s.file));
    expect(uncovered.map(s => s.file)).toEqual([]);
    const both = CSV_SLOTS.filter(s => keepsExtras.has(s.file) && dropsExtras.has(s.file));
    expect(both.map(s => s.file)).toEqual([]);
  });

  it('has a schema template behind every slot, so the mapping panel can offer its fields', () => {
    for (const slot of CSV_SLOTS) {
      expect(schemaColumnsFor(slot.key).length, `${slot.file} has no readable schema template`).toBeGreaterThan(0);
    }
  });

  it('declares only required columns the slot\'s own template actually has', () => {
    for (const slot of CSV_SLOTS) {
      const columns = schemaColumnsFor(slot.key).map(c => c.toLowerCase());
      for (const required of slot.requiredColumns || []) {
        expect(columns, `${slot.file} requires ${required}, which is not in its template`).toContain(required.toLowerCase());
      }
    }
  });
});
