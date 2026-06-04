// Docs-drift guard: every permission in the catalog must be documented in
// docs/reference/permissions.md. If you add a permission to PERMISSIONS without
// documenting it, this fails CI — keeping the reference page honest.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PERMISSIONS } from './permissions.js';

const here = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = join(here, '../../../../docs/reference/permissions.md');
const doc = readFileSync(DOC_PATH, 'utf8');

describe('permissions reference documentation coverage', () => {
  for (const key of Object.keys(PERMISSIONS)) {
    it(`documents the "${key}" permission`, () => {
      expect(
        doc.includes(key),
        `Permission "${key}" is in the catalog but missing from docs/reference/permissions.md. ` +
          'Document it (with its label and how it is enforced).'
      ).toBe(true);
    });
  }
});
