import security from 'eslint-plugin-security';

export default [
  security.configs.recommended,
  {
    // app-bundle.mjs is a generated desktop bundle — not hand-written source
    ignores: ['node_modules/', 'patches/', 'src/app-bundle.mjs'],
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
