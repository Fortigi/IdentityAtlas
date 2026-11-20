// npm audit gate with time-boxed exceptions.
//
// `npm audit --audit-level=high` cannot ignore a single advisory, so one
// advisory with no fixed version anywhere (no upgrade can clear it) blocks
// every PR. This gate reads `npm audit --json` and fails on every high or
// critical advisory, except the ones listed in .ci/npm-audit-exceptions.json
// for that exact package, until their `expires` date. An expired exception
// fails the gate again, so an exception cannot be forgotten.
//
// Usage (from app/ui or app/api):
//   npm audit --json > audit.json || true
//   node ../../tools/npm-audit/auditGate.mjs audit.json ../../.ci/npm-audit-exceptions.json

import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';

const BLOCKING = new Set(['high', 'critical']);

function advisoryId(url) {
  const m = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i.exec(url || '');
  return m ? m[0] : url;
}

// The advisories themselves are the object entries of `via`; string entries
// only say "depends on a vulnerable package" and add nothing new.
export function blockingAdvisories(report) {
  if (!report || typeof report !== 'object' || !report.vulnerabilities) {
    throw new Error(`Not an npm audit report: ${JSON.stringify(report?.error ?? report).slice(0, 300)}`);
  }
  const found = new Map();
  for (const vuln of Object.values(report.vulnerabilities)) {
    for (const via of vuln.via || []) {
      if (typeof via !== 'object' || !BLOCKING.has(via.severity)) continue;
      const id = advisoryId(via.url);
      found.set(`${id}|${via.name}`, { id, package: via.name, severity: via.severity, title: via.title, url: via.url });
    }
  }
  return [...found.values()];
}

export function evaluate(advisories, exceptions, today) {
  const isExpired = (e) => !(e.expires >= today);
  const covering = (a) => exceptions.find((e) => e.id === a.id && e.package === a.package);
  const blocked = [];
  const excepted = [];
  for (const a of advisories) {
    const e = covering(a);
    if (!e) blocked.push(a);
    else if (isExpired(e)) blocked.push({ ...a, expiredException: e.expires });
    else excepted.push({ ...a, expires: e.expires });
  }
  const unused = exceptions.filter((e) => !advisories.some((a) => a.id === e.id && a.package === e.package));
  return { blocked, excepted, unused, ok: blocked.length === 0 };
}

export function formatResult({ blocked, excepted, unused }) {
  const lines = [];
  for (const a of blocked) {
    const why = a.expiredException ? ` (exception expired ${a.expiredException})` : '';
    lines.push(`BLOCKED  ${a.severity} ${a.package} ${a.id}${why}: ${a.title} ${a.url}`);
  }
  for (const a of excepted) lines.push(`EXCEPTED ${a.severity} ${a.package} ${a.id} until ${a.expires}`);
  for (const e of unused) lines.push(`UNUSED   exception ${e.package} ${e.id} is no longer reported: remove it from .ci/npm-audit-exceptions.json`);
  return lines.join('\n');
}

export function main(argv, { read = (p) => readFileSync(p, 'utf-8'), today = new Date().toISOString().slice(0, 10), log = console.log } = {}) {
  const [reportPath, exceptionsPath] = argv;
  const report = JSON.parse(read(reportPath));
  const exceptions = JSON.parse(read(exceptionsPath));
  const result = evaluate(blockingAdvisories(report), exceptions, today);
  log(formatResult(result) || 'No high or critical advisories.');
  return result.ok ? 0 : 1;
}

/* c8 ignore next 3 -- the CLI entry point; main() is tested directly */
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = main(process.argv.slice(2));
}
