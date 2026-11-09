// The UI's ESLint config switches on @eslint/js recommended (review item A3): the
// package was a dependency all along, but no config used it, so a typo'd variable
// or a duplicated object key reached review. Checked against the config ESLint
// actually resolves for a source file, so a later edit that drops or overrides
// the set fails here rather than silently.
import { describe, it, expect, beforeAll } from 'vitest';
import { ESLint } from 'eslint';
import js from '@eslint/js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const uiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
let linter;
let resolved;

beforeAll(async () => {
  linter = new ESLint({ cwd: uiRoot });
  resolved = (await linter.calculateConfigForFile(join(uiRoot, 'src', 'main.jsx'))).rules;
});

const isError = (setting) => [2, 'error'].includes(Array.isArray(setting) ? setting[0] : setting);
const ruleIdsFor = async (code, file) =>
  (await linter.lintText(code, { filePath: join(uiRoot, file) }))[0].messages.map((m) => m.ruleId);

describe('UI ESLint config', () => {
  it('has every recommended rule at error severity for src/', () => {
    const notErrors = Object.keys(js.configs.recommended.rules).filter((rule) => !isError(resolved[rule]));
    expect(notErrors).toEqual([]);
  });

  it('lets an underscore or a rest sibling mark an unused value, nothing else', () => {
    const [, options] = resolved['no-unused-vars'];
    expect(options.argsIgnorePattern).toBe('^_');
    expect(options.varsIgnorePattern).toBe('^_');
    expect(options.ignoreRestSiblings).toBe(true);
    expect(options.caughtErrors).toBe('all');
  });

  it.each([
    ['a browser global in src/', 'export const href = window.location.href;\n', 'src/probe.js', false],
    ['a Node global in a unit test', 'export const b = Buffer.from("x");\n', 'src/probe.test.js', false],
    ['a Node global in src/', 'export const b = Buffer.from("x");\n', 'src/probe.js', true],
    ['a name defined nowhere', 'export const v = notDefinedAnywhere;\n', 'src/probe.js', true],
  ])('no-undef on %s: flagged = %s', async (_label, code, file, flagged) => {
    expect((await ruleIdsFor(code, file)).includes('no-undef')).toBe(flagged);
  });
});
