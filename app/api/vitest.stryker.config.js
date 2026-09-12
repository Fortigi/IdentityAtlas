import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Vitest config used only by the mutation runs (stryker.*.config.json).
//
// Stryker copies app/api into a temp sandbox and runs from there. Any test that
// reads the real filesystem — an upload landing under {UPLOAD_ROOT}, or the
// crawler manifests at ../../tools/crawlers — resolves a path that does not
// exist in the sandbox, fails the dry run, and aborts the whole mutation run
// before a single mutant is evaluated. Those tests are fine; the sandbox is the
// problem.
//
// The fix is a narrow include rather than a growing exclude list. An excluded
// test that happened to be some mutant's only killer would show up as a false
// survivor, which is worse than measuring less.

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    // Only the auth unit tests, plus the one route-level file whose rule is the
    // same kind of thing (#1166: who may open a shared matrix). Stryker
    // sandboxes app/api alone, so anything reading the real filesystem or the
    // tools/crawlers manifests outside it fails the dry run and aborts the run
    // before a mutant is evaluated. These are fully mocked and self-contained —
    // shareRecipients.test.js touches no database and no request object, which
    // is why it can be named here while the rest of src/routes/** cannot.
    // Narrow scope beats a growing exclude list: an excluded test that happened
    // to be a mutant's only killer would show up as a false survivor.
    include: [
      'src/auth/**/*.test.js',
      'src/routes/matrix/shareRecipients.test.js',
    ],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
