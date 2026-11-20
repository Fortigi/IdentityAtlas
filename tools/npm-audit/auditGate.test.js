import { describe, it, expect } from 'vitest';
import { blockingAdvisories, evaluate, formatResult, main } from './auditGate.mjs';

// Shaped like real `npm audit --json` output (app/ui, November 2026): one
// high advisory with dependents that only name it, one moderate advisory.
const PICO = {
  source: 1247710, name: 'picomatch', dependency: 'picomatch', severity: 'high',
  title: 'picomatch vulnerable to ReDoS', url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf', range: '<=4.0.7',
};
const MINI = {
  source: 1244623, name: 'minimatch', dependency: 'minimatch', severity: 'moderate',
  title: 'minimatch DoS', url: 'https://github.com/advisories/GHSA-g3hv-75wg-m249', range: '>=7.0.0 <11.0.1',
};
const report = (extra = {}) => ({
  vulnerabilities: {
    picomatch: { severity: 'high', via: [PICO] },
    fdir: { severity: 'high', via: ['picomatch'] },
    vite: { severity: 'high', via: ['picomatch', 'tinyglobby'] },
    minimatch: { severity: 'moderate', via: [MINI] },
    ...extra,
  },
});
const EXC = { id: 'GHSA-fc5q-39xc-vjpf', package: 'picomatch', expires: '2026-12-16' };

describe('blockingAdvisories', () => {
  it('returns each high advisory once, ignoring dependents and moderates', () => {
    expect(blockingAdvisories(report())).toEqual([
      { id: 'GHSA-fc5q-39xc-vjpf', package: 'picomatch', severity: 'high', title: PICO.title, url: PICO.url },
    ]);
  });

  it('includes critical advisories and keeps the same advisory on two packages apart', () => {
    const crit = { ...PICO, name: 'other', severity: 'critical' };
    const ids = blockingAdvisories(report({ other: { severity: 'critical', via: [crit] }, dup: { via: [PICO] } }))
      .map((a) => `${a.package}:${a.severity}`);
    expect(ids).toEqual(['picomatch:high', 'other:critical']);
  });

  it('refuses something that is not an audit report', () => {
    expect(() => blockingAdvisories({ error: { code: 'ENOTFOUND' } })).toThrow(/Not an npm audit report.*ENOTFOUND/);
    expect(() => blockingAdvisories(null)).toThrow(/Not an npm audit report/);
  });
});

describe('evaluate', () => {
  const advisories = blockingAdvisories(report());

  it('passes when every blocking advisory has a live exception', () => {
    const r = evaluate(advisories, [EXC], '2026-11-18');
    expect(r.ok).toBe(true);
    expect(r.excepted.map((a) => a.expires)).toEqual(['2026-12-16']);
    expect(r.blocked).toEqual([]);
  });

  it('still passes on the expiry day itself and fails the day after', () => {
    expect(evaluate(advisories, [EXC], '2026-12-16').ok).toBe(true);
    const r = evaluate(advisories, [EXC], '2026-12-17');
    expect(r.ok).toBe(false);
    expect(r.blocked[0].expiredException).toBe('2026-12-16');
  });

  it('fails without an exception, or when the exception names another package', () => {
    expect(evaluate(advisories, [], '2026-11-18').ok).toBe(false);
    expect(evaluate(advisories, [{ ...EXC, package: 'minimatch' }], '2026-11-18').ok).toBe(false);
  });

  it('fails an exception without a date instead of treating it as forever', () => {
    expect(evaluate(advisories, [{ id: EXC.id, package: EXC.package }], '2026-11-18').ok).toBe(false);
  });

  it('blocks a new advisory even while another one is excepted', () => {
    const other = { ...PICO, name: 'lodash', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' };
    const r = evaluate(blockingAdvisories(report({ lodash: { via: [other] } })), [EXC], '2026-11-18');
    expect(r.ok).toBe(false);
    expect(r.blocked.map((a) => a.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
  });

  it('reports an exception that is no longer needed, without failing', () => {
    const r = evaluate([], [EXC], '2026-11-18');
    expect(r.ok).toBe(true);
    expect(r.unused).toEqual([EXC]);
  });
});

describe('formatResult and main', () => {
  const files = (rep, exc) => (p) => (p === 'audit.json' ? JSON.stringify(rep) : JSON.stringify(exc));

  it('prints one line per finding', () => {
    const text = formatResult(evaluate(blockingAdvisories(report()), [EXC], '2026-12-17'));
    expect(text).toBe(`BLOCKED  high picomatch GHSA-fc5q-39xc-vjpf (exception expired 2026-12-16): ${PICO.title} ${PICO.url}`);
    expect(formatResult(evaluate(blockingAdvisories(report()), [EXC], '2026-11-18')))
      .toBe('EXCEPTED high picomatch GHSA-fc5q-39xc-vjpf until 2026-12-16');
    expect(formatResult(evaluate([], [EXC], '2026-11-18'))).toMatch(/^UNUSED   exception picomatch GHSA-fc5q-39xc-vjpf/);
  });

  it('returns exit code 0 with a live exception and 1 without', () => {
    const out = [];
    expect(main(['audit.json', 'exc.json'], { read: files(report(), [EXC]), today: '2026-11-18', log: (l) => out.push(l) })).toBe(0);
    expect(main(['audit.json', 'exc.json'], { read: files(report(), []), today: '2026-11-18', log: (l) => out.push(l) })).toBe(1);
    expect(out[1]).toMatch(/^BLOCKED/);
  });

  it('says so when nothing is high or critical', () => {
    const out = [];
    const clean = { vulnerabilities: { minimatch: { via: [MINI] } } };
    expect(main(['audit.json', 'exc.json'], { read: files(clean, []), today: '2026-11-18', log: (l) => out.push(l) })).toBe(0);
    expect(out).toEqual(['No high or critical advisories.']);
  });
});
