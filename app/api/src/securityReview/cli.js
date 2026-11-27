// `node src/securityReview/cli.js <command>` (app/api) — the deterministic half
// of the monthly security review (.github/workflows/security-review.yml).
//
//   validate <findings.json>
//       Check the file the review wrote. Exit 1 with the problems if it is not valid.
//   file <findings.json> <filings.json> [--dry-run]
//       Create the issues and private advisories for new findings and write
//       which filing tracks which finding. Needs GH_TOKEN and GITHUB_REPOSITORY;
//       SECURITY_BOARD_PROJECT_ID adds new issues to that board; REVIEW_URL is
//       linked from every filing; SECURITY_REVIEW_ASSIGNEES (comma-separated
//       logins) are assigned every new issue. --dry-run prints the plan and files nothing.
//   publish <findings.json> <filings.json> <docs/security>
//       Write the public review page and add it to the assessment history.

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { validateReport } from './findings.js';
import { executeFilings, planFilings } from './filings.js';
import { createGitHubClient } from './github.js';
import { pageFileName, renderPublicPage, updateIndex } from './publicPage.js';
import { openCommand } from './reportFile.js';

const USAGE = 'usage: cli.js validate <findings.json> | file <findings.json> <filings.json> [--dry-run] | publish <findings.json> <filings.json> <docs-dir>';

const defaultDeps = {
  readFile: p => readFileSync(p, 'utf8'),
  writeFile: (p, s) => writeFileSync(p, s),
  env: process.env,
  createClient: createGitHubClient,
  log: console.log,
};

function describePlan(plan) {
  return plan.map(e => {
    const kind = e.private ? 'advisory + placeholder issue' : 'public issue';
    const what = e.action === 'known' ? `already tracked (${e.existing.html_url})` : `new ${kind}${e.regressionOf ? ' (regression)' : ''}`;
    return `${e.finding.id} ${e.finding.severity}: ${what}`;
  });
}

async function fileCommand(report, filingsPath, dryRun, deps) {
  const { GH_TOKEN, GITHUB_REPOSITORY, SECURITY_BOARD_PROJECT_ID, REVIEW_URL = '', SECURITY_REVIEW_ASSIGNEES = '' } = deps.env;
  const assignees = SECURITY_REVIEW_ASSIGNEES.split(',').map(s => s.trim()).filter(Boolean);
  const client = deps.createClient({ token: GH_TOKEN, repo: GITHUB_REPOSITORY, projectId: SECURITY_BOARD_PROJECT_ID });
  const existing = { issues: await client.listIssues(), advisories: await client.listAdvisories() };
  const plan = planFilings(report.findings, existing);
  describePlan(plan).forEach(line => deps.log(line));
  if (dryRun) return 0;
  const filings = await executeFilings(plan, client, REVIEW_URL, { assignees });
  deps.writeFile(filingsPath, `${JSON.stringify(filings, null, 2)}\n`);
  return 0;
}

function publishCommand(report, filingsPath, docsDir, deps) {
  const filings = JSON.parse(deps.readFile(filingsPath));
  deps.writeFile(join(docsDir, pageFileName(report.reviewId)), renderPublicPage(report, filings));
  const indexPath = join(docsDir, 'index.md');
  deps.writeFile(indexPath, updateIndex(deps.readFile(indexPath), report));
  deps.log(`Wrote ${pageFileName(report.reviewId)} and updated index.md`);
  return 0;
}

export async function main(argv, deps = defaultDeps) {
  const opened = openCommand(argv, deps, { commands: ['validate', 'file', 'publish'], usage: USAGE, validate: validateReport });
  if ('exit' in opened) return opened.exit;
  const { command, report, args: [second, third] } = opened;
  if (!second || (command === 'publish' && !third)) {
    deps.log(USAGE);
    return 2;
  }
  if (command === 'file') return fileCommand(report, second, third === '--dry-run', deps);
  return publishCommand(report, second, third, deps);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => process.exit(code), err => { console.error(err.message); process.exit(1); });
}
