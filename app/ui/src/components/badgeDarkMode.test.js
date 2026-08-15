import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The compliance + account-type badge maps are applied raw (no per-call dark:
// override), so each colour entry must carry a dark: variant or the badge is
// a bright pastel block on a dark surface. Guard the dark coverage.
const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f), 'utf8');

describe('status/account badge dark-mode coverage', () => {
  it('AccessPackages COMPLIANCE_STYLES all carry dark: variants', () => {
    // COMPLIANCE_STYLES is the shared map in utils/accessPackageStyles.js.
    const src = read('../utils/accessPackageStyles.js');
    for (const tok of ['dark:bg-green-900/30', 'dark:bg-blue-900/30', 'dark:bg-red-900/30', 'dark:bg-amber-900/30']) {
      expect(src, tok).toContain(tok);
    }
  });

  it('UserDetail ACCOUNT_TYPE_COLORS all carry dark: variants', () => {
    const src = read('UserDetailPage.jsx');
    for (const tok of ['dark:bg-blue-900/30', 'dark:bg-red-900/30', 'dark:bg-amber-900/30', 'dark:bg-purple-900/30', 'dark:bg-teal-900/30', 'dark:bg-gray-800']) {
      expect(src, tok).toContain(tok);
    }
  });

  it('ContextTreeSelector select inputs and selected row carry dark: variants', () => {
    const src = read('contexts/ContextTreeSelector.jsx');
    for (const tok of ['dark:bg-gray-700', 'dark:border-gray-600', 'dark:text-gray-200', 'dark:bg-blue-900/30']) {
      expect(src, tok).toContain(tok);
    }
  });
});
