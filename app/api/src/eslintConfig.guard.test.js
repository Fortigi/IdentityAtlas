// ESLint's own correctness rules (@eslint/js recommended) are on for the API, as
// resolved by ESLint itself for a real source file. They were off until review
// item A3 -- the dependency was installed and never used -- so no-undef,
// no-dupe-keys and no-unused-vars caught nothing. This keeps them from being
// dropped from eslint.config.js again without anyone noticing.
import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import js from '@eslint/js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const severity = v => (Array.isArray(v) ? v[0] : v);

describe('API ESLint config', () => {
  it('enforces every @eslint/js recommended rule on source files', async () => {
    const eslint = new ESLint({ cwd: pkgDir });
    const { rules } = await eslint.calculateConfigForFile(join(pkgDir, 'src', 'index.js'));
    const off = Object.keys(js.configs.recommended.rules).filter(r => ![2, 'error'].includes(severity(rules[r])));
    expect(off).toEqual([]);
  });

  it('allows only underscore-marked and rest-sibling unused values', async () => {
    const eslint = new ESLint({ cwd: pkgDir });
    const { rules } = await eslint.calculateConfigForFile(join(pkgDir, 'src', 'index.js'));
    expect(rules['no-unused-vars'][1]).toMatchObject({
      argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'all', ignoreRestSiblings: true,
    });
  });

  it('knows Node globals, so no-undef does not fire on process', async () => {
    const eslint = new ESLint({ cwd: pkgDir });
    const [result] = await eslint.lintText('export const env = process.env.X;\n', {
      filePath: join(pkgDir, 'src', 'guard-probe.js'),
    });
    expect(result.messages.map(m => m.ruleId)).not.toContain('no-undef');
    const [bad] = await eslint.lintText('export const v = notDefinedAnywhere;\n', {
      filePath: join(pkgDir, 'src', 'guard-probe.js'),
    });
    expect(bad.messages.map(m => m.ruleId)).toContain('no-undef');
  });
});
