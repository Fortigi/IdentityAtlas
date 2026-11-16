// `npm run docs:check` / `npm run docs:baseline` (app/api).
//
//   check     measure retired vocabulary and broken links in docs/ and compare
//             with the committed baselines. Exit 1 on anything that got worse.
//   baseline  lower the baselines to what docs/ contains now. Only ever
//             lowers: something that got WORSE keeps its old ceiling and still
//             fails `check`. `baseline --allow-increase` writes the measurement
//             as it is and prints each raised entry — for a reviewed exception.
//
// The same comparison runs as a test (docsDrift.guard.test.js) in the
// `Unit Tests: Vitest (API)` PR check; this file is the way to run and
// regenerate it by hand.

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { repoRoot } from '../lib/repoRoot.js';
import { docsJargon, replacementFor } from './docsJargon.js';
import { docsLinks } from './docsLinks.js';
import { compare, describe, tighten } from './docsRatchet.js';

const REGENERATE = 'cd app/api && npm run docs:baseline';

// One entry per ratcheted measurement. `hint` turns a regression into what the
// author should do about it.
export const RATCHETS = [
  {
    name: 'retired vocabulary',
    file: 'docs-jargon-baseline.json',
    measure: docsJargon,
    hint: r => `write "${replacementFor(r.item)}"`,
    comment:
      'Retired-vocabulary ratchet for docs/. Pages that still use a banned term ' +
      '(app/api/src/docs/docsJargon.js), with the number of occurrences per term. A count ' +
      'may only go DOWN; a new term or a new page fails the Unit Tests: Vitest (API) check. ' +
      `Fewer occurrences than listed never fail. Lower it with: ${REGENERATE}`,
  },
  {
    name: 'broken links and anchors',
    file: 'docs-links-baseline.json',
    measure: docsLinks,
    hint: () => 'fix the target, or the heading it points at',
    comment:
      'Link-and-anchor ratchet for docs/. Links that are broken today ' +
      '(app/api/src/docs/docsLinks.js), per page, with the number of occurrences. The list ' +
      'may only shrink; a new broken link or anchor fails the Unit Tests: Vitest (API) check. ' +
      `Lower it with: ${REGENERATE}`,
  },
];

export const baselineDir = () => join(repoRoot(), '.ci');

/** The `pages` of a committed baseline; empty when the file does not exist yet. */
export function readBaseline(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')).pages ?? {};
}

/** Measure one ratchet against its baseline in `dir`. */
export function checkRatchet(ratchet, dir = baselineDir(), current = ratchet.measure()) {
  const baseline = readBaseline(join(dir, ratchet.file));
  return { current, baseline, ...compare(current, baseline) };
}

/** The failure text for a ratchet's regressions. */
export function failureMessage(ratchet, regressions) {
  const rows = regressions.map(r => `  - ${describe(r)} → ${ratchet.hint(r)}`);
  return `docs ${ratchet.name}: ${regressions.length} new finding(s):\n${rows.join('\n')}`;
}

/**
 * Rewrite one baseline from a measurement. Returns the entries that were
 * lowered and (with allowIncrease) raised; writes only when something changed.
 */
export function updateBaseline(ratchet, { dir = baselineDir(), allowIncrease = false, current } = {}) {
  const { current: now, baseline, regressions, improvements } = checkRatchet(ratchet, dir, current);
  const pages = tighten(now, baseline, { allowIncrease });
  const raised = allowIncrease ? regressions : [];
  if (improvements.length > 0 || raised.length > 0) {
    const body = { _comment: ratchet.comment, pages };
    writeFileSync(join(dir, ratchet.file), `${JSON.stringify(body, null, 2)}\n`);
  }
  return { lowered: improvements, raised, refused: allowIncrease ? [] : regressions };
}

function runCheck(io, opts) {
  let failed = 0;
  for (const ratchet of RATCHETS) {
    const { regressions, improvements } = checkRatchet(ratchet, opts.dir, opts.measure?.(ratchet));
    if (regressions.length > 0) { io.error(failureMessage(ratchet, regressions)); failed += 1; }
    if (improvements.length > 0) {
      io.log(`docs ${ratchet.name}: ${improvements.length} entry(ies) improved — lock it in with: ${REGENERATE}`);
    }
  }
  if (failed === 0) io.log('Docs drift check passed.');
  return failed === 0 ? 0 : 1;
}

function runBaseline(io, opts, allowIncrease) {
  let refusedAny = false;
  for (const ratchet of RATCHETS) {
    const result = updateBaseline(ratchet, { dir: opts.dir, allowIncrease, current: opts.measure?.(ratchet) });
    for (const r of result.lowered) io.log(`lowered  ${describe(r)}`);
    for (const r of result.raised) io.log(`RAISED   ${describe(r)}`);
    for (const r of result.refused) io.error(`refused  ${describe(r)} (got worse; fix the page, or rerun with --allow-increase)`);
    refusedAny ||= result.refused.length > 0;
  }
  return refusedAny ? 1 : 0;
}

/** `opts.dir` and `opts.measure` let the tests run against a scratch baseline. */
export function main(argv, io = console, opts = {}) {
  const [cmd, ...flags] = argv;
  if (cmd === 'check') return runCheck(io, opts);
  if (cmd === 'baseline') return runBaseline(io, opts, flags.includes('--allow-increase'));
  io.error('usage: node src/docs/cli.js <check|baseline [--allow-increase]>');
  return 2;
}

/* v8 ignore next 3 -- the process entry point; main() itself is tested */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
