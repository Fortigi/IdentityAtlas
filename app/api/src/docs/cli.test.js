// The check/baseline commands against a scratch baseline directory and a
// supplied measurement — the committed baselines are never touched here.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RATCHETS, checkRatchet, failureMessage, main, readBaseline, updateBaseline } from './cli.js';

const [JARGON, LINKS] = RATCHETS;

let dir;
let out;
let err;
const io = { log: line => out.push(line), error: line => err.push(line) };

const seed = (ratchet, pages) =>
  writeFileSync(join(dir, ratchet.file), JSON.stringify({ _comment: 'x', pages }));
const stored = ratchet => JSON.parse(readFileSync(join(dir, ratchet.file), 'utf8'));
// Jargon gets `jargon`; the link ratchet always measures clean unless told otherwise.
const measuring = (jargon, links = {}) => ({ dir, measure: r => (r === JARGON ? jargon : links) });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'docs-ratchet-'));
  out = [];
  err = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readBaseline', () => {
  it('is empty when the file does not exist', () => {
    expect(readBaseline(join(dir, 'nope.json'))).toEqual({});
  });

  it('returns the pages, not the comment', () => {
    seed(JARGON, { 'a.md': { SOLL: 1 } });
    expect(readBaseline(join(dir, JARGON.file))).toEqual({ 'a.md': { SOLL: 1 } });
  });
});

describe('check', () => {
  it('passes when the measurement equals the baseline', () => {
    seed(JARGON, { 'a.md': { SOLL: 2 } });
    expect(main(['check'], io, measuring({ 'a.md': { SOLL: 2 } }))).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual(['Docs drift check passed.']);
  });

  it('fails on one more occurrence and says what to write instead', () => {
    seed(JARGON, { 'a.md': { SOLL: 2 } });
    expect(main(['check'], io, measuring({ 'a.md': { SOLL: 3 } }))).toBe(1);
    expect(err).toEqual([
      'docs retired vocabulary: 1 new finding(s):\n  - a.md: SOLL — 3 now, 2 allowed → write "governed"',
    ]);
    expect(out).not.toContain('Docs drift check passed.');
  });

  it('fails on a page that is not in the baseline', () => {
    seed(JARGON, { 'a.md': { SOLL: 2 } });
    expect(main(['check'], io, measuring({ 'a.md': { SOLL: 2 }, 'new.md': { IST: 1 } }))).toBe(1);
    expect(err[0]).toContain('new.md: IST — 1 now, 0 allowed → write "non-governed"');
  });

  it('passes when a count dropped, and says how to lock it in', () => {
    seed(JARGON, { 'a.md': { SOLL: 2 } });
    expect(main(['check'], io, measuring({ 'a.md': { SOLL: 1 } }))).toBe(0);
    expect(err).toEqual([]);
    expect(out[0]).toBe('docs retired vocabulary: 1 entry(ies) improved — lock it in with: cd app/api && npm run docs:baseline');
  });

  it('fails on a new broken link even when the vocabulary is clean', () => {
    expect(main(['check'], io, measuring({}, { 'a.md': { 'b.md#gone': 1 } }))).toBe(1);
    expect(err).toEqual([
      'docs broken links and anchors: 1 new finding(s):\n  - a.md: b.md#gone — 1 now, 0 allowed → fix the target, or the heading it points at',
    ]);
  });
});

describe('baseline', () => {
  it('lowers a count that dropped and removes a page that is clean', () => {
    seed(JARGON, { 'a.md': { SOLL: 4 }, 'b.md': { IST: 1 } });
    expect(main(['baseline'], io, measuring({ 'a.md': { SOLL: 1 } }))).toBe(0);
    expect(stored(JARGON).pages).toEqual({ 'a.md': { SOLL: 1 } });
    expect(stored(JARGON)._comment).toBe(JARGON.comment);
    expect(out).toEqual(['lowered  a.md: SOLL — 1 now, 4 allowed', 'lowered  b.md: IST — 0 now, 1 allowed']);
  });

  it('refuses to absorb a regression: exit 1, ceiling unchanged', () => {
    seed(JARGON, { 'a.md': { SOLL: 2 } });
    expect(main(['baseline'], io, measuring({ 'a.md': { SOLL: 5 } }))).toBe(1);
    expect(stored(JARGON).pages).toEqual({ 'a.md': { SOLL: 2 } });
    expect(err).toEqual(['refused  a.md: SOLL — 5 now, 2 allowed (got worse; fix the page, or rerun with --allow-increase)']);
  });

  it('lowers what improved while refusing what got worse, in one run', () => {
    seed(JARGON, { 'a.md': { SOLL: 2 }, 'b.md': { IST: 3 } });
    expect(main(['baseline'], io, measuring({ 'a.md': { SOLL: 5 }, 'b.md': { IST: 1 } }))).toBe(1);
    expect(stored(JARGON).pages).toEqual({ 'a.md': { SOLL: 2 }, 'b.md': { IST: 1 } });
  });

  it('raises a ceiling only with --allow-increase, and says so', () => {
    seed(JARGON, { 'a.md': { SOLL: 2 } });
    expect(main(['baseline', '--allow-increase'], io, measuring({ 'a.md': { SOLL: 5 } }))).toBe(0);
    expect(stored(JARGON).pages).toEqual({ 'a.md': { SOLL: 5 } });
    expect(out).toEqual(['RAISED   a.md: SOLL — 5 now, 2 allowed']);
    expect(err).toEqual([]);
  });

  it('writes the first baseline with --allow-increase', () => {
    expect(main(['baseline', '--allow-increase'], io, measuring({}, { 'a.md': { '#x': 1 } }))).toBe(0);
    expect(stored(LINKS)).toEqual({ _comment: LINKS.comment, pages: { 'a.md': { '#x': 1 } } });
    expect(existsSync(join(dir, JARGON.file))).toBe(false);
  });

  it('leaves the file byte-identical when nothing moved', () => {
    seed(JARGON, { 'a.md': { SOLL: 2 } });
    const before = readFileSync(join(dir, JARGON.file), 'utf8');
    expect(main(['baseline'], io, measuring({ 'a.md': { SOLL: 2 } }))).toBe(0);
    expect(readFileSync(join(dir, JARGON.file), 'utf8')).toBe(before);
    expect(out).toEqual([]);
  });
});

describe('updateBaseline / checkRatchet', () => {
  it('reports lowered, raised and refused separately', () => {
    seed(JARGON, { 'a.md': { SOLL: 2 }, 'b.md': { IST: 3 } });
    const current = { 'a.md': { SOLL: 5 }, 'b.md': { IST: 1 } };
    const strict = updateBaseline(JARGON, { dir, current });
    expect(strict.lowered.map(r => r.page)).toEqual(['b.md']);
    expect(strict.refused.map(r => r.page)).toEqual(['a.md']);
    expect(strict.raised).toEqual([]);

    const loose = updateBaseline(JARGON, { dir, current, allowIncrease: true });
    expect(loose.raised.map(r => r.page)).toEqual(['a.md']);
    expect(loose.refused).toEqual([]);
  });

  it('returns the measurement next to the baseline', () => {
    seed(LINKS, { 'a.md': { '#x': 1 } });
    const result = checkRatchet(LINKS, dir, {});
    expect(result.baseline).toEqual({ 'a.md': { '#x': 1 } });
    expect(result.current).toEqual({});
    expect(result.improvements).toHaveLength(1);
  });
});

describe('failureMessage', () => {
  it('lists every regression with its hint', () => {
    const text = failureMessage(JARGON, [
      { page: 'a.md', item: 'Org Unit', was: 0, now: 2 },
      { page: 'b.md', item: 'IST', was: 1, now: 2 },
    ]);
    expect(text).toBe(
      'docs retired vocabulary: 2 new finding(s):\n' +
      '  - a.md: Org Unit — 2 now, 0 allowed → write "context"\n' +
      '  - b.md: IST — 2 now, 1 allowed → write "non-governed"',
    );
  });
});

describe('usage', () => {
  it('prints usage and exits 2 for an unknown command', () => {
    expect(main(['frobnicate'], io)).toBe(2);
    expect(err).toEqual(['usage: node src/docs/cli.js <check|baseline [--allow-increase]>']);
  });
});
