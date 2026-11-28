import { describe, expect, it } from 'vitest';
import { FINGERPRINT, duplicateProblems, openCommand, textProblems } from './reportFile.js';

describe('textProblems', () => {
  const fields = [['title', 5], ['body', 3]];

  it('passes text at its limit and flags one character past it, blank and missing text', () => {
    expect(textProblems({ title: 'abcde', body: 'abc' }, 'f[0]', fields)).toEqual([]);
    expect(textProblems({ title: 'abcdef', body: '   ' }, 'f[0]', fields)).toEqual([
      'f[0]: title is longer than 5 characters',
      'f[0]: body is required',
    ]);
    expect(textProblems({ title: 7 }, 'f[1]', fields)).toEqual(['f[1]: title is required', 'f[1]: body is required']);
  });
});

describe('duplicateProblems', () => {
  it('names a fingerprint once per extra appearance and leaves distinct ones alone', () => {
    const f = fp => ({ fingerprint: fp });
    expect(duplicateProblems([f('aaaaaa'), f('bbbbbb'), f('aaaaaa'), f('aaaaaa')])).toEqual([
      'fingerprint aaaaaa appears twice',
      'fingerprint aaaaaa appears twice',
    ]);
    expect(duplicateProblems([f('aaaaaa'), f('aaaaab')])).toEqual([]);
  });
});

describe('FINGERPRINT', () => {
  it('takes 6 to 120 lowercase characters starting with a letter or digit', () => {
    expect(FINGERPRINT.test('abcdef')).toBe(true);
    expect(FINGERPRINT.test('abcde')).toBe(false);
    expect(FINGERPRINT.test(`a${'b'.repeat(119)}`)).toBe(true);
    expect(FINGERPRINT.test(`a${'b'.repeat(120)}`)).toBe(false);
    expect(FINGERPRINT.test('-abcdef')).toBe(false);
    expect(FINGERPRINT.test('Abcdef')).toBe(false);
  });
});

describe('openCommand', () => {
  const validate = r => (r.bad ? { ok: false, problems: ['p1', 'p2'] } : { ok: true, report: { ...r, checked: true } });
  const run = (argv, file = '{"findings":[1,2]}') => {
    const logs = [];
    const out = openCommand(argv, { readFile: () => file, log: l => logs.push(l) }, { commands: ['validate', 'file'], usage: 'USAGE', validate });
    return { out, logs };
  };

  it('stops with 2 and the usage for an unknown command or a missing path', () => {
    expect(run(['publish', 'x.json'])).toEqual({ out: { exit: 2 }, logs: ['USAGE'] });
    expect(run(['file'])).toEqual({ out: { exit: 2 }, logs: ['USAGE'] });
  });

  it('stops with 1 and every problem for an invalid or unreadable file', () => {
    expect(run(['file', 'x.json'], '{"bad":true}')).toEqual({ out: { exit: 1 }, logs: ['invalid: p1', 'invalid: p2'] });
    const junk = run(['validate', 'x.json'], 'nope');
    expect(junk.out).toEqual({ exit: 1 });
    expect(junk.logs[0]).toMatch(/^invalid: x\.json is not readable JSON: /);
  });

  it('finishes validate with 0, and hands any other command the validated report and the rest of the arguments', () => {
    expect(run(['validate', 'x.json'])).toEqual({ out: { exit: 0 }, logs: ['x.json is valid: 2 findings'] });
    expect(run(['file', 'x.json', 'out.json', '--dry-run'])).toEqual({
      out: { command: 'file', report: { findings: [1, 2], checked: true }, args: ['out.json', '--dry-run'] },
      logs: [],
    });
  });
});
