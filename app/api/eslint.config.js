import security from 'eslint-plugin-security';
import sonarjs from 'eslint-plugin-sonarjs';

export default [
  security.configs.recommended,
  {
    // app-bundle.mjs is a generated desktop bundle — not hand-written source
    ignores: ['node_modules/', 'patches/', 'src/app-bundle.mjs'],
  },
  {
    // Register the sonarjs plugin WITHOUT enabling any of its rules, so the
    // `sonarjs/cognitive-complexity` rule id resolves when the complexity
    // ratchet injects it via `--rule` (tools/complexity/ratchet.py measure_js).
    // Deliberately not `sonarjs.configs.recommended` — that would enable a raft
    // of rules and fail `npm run lint`. Same treatment as the core `complexity`
    // (cyclomatic) rule: measured by the ratchet, never enforced in the lint job.
    plugins: { sonarjs },
  },
  {
    rules: {
      // Fires on every obj[key] access — almost always a false positive in
      // normal application code.
      'security/detect-object-injection': 'off',

      // All fs calls in this codebase use internal path variables, never raw
      // user input — the paths are derived from config or hardcoded prefixes.
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
];
