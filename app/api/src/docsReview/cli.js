// `node app/api/src/docsReview/cli.js <command>` (from the repository root) —
// the deterministic half of the monthly docs audit (.github/workflows/docs-audit.yml).
//
//   validate <findings.json>
//       Check the file the audit wrote. Exit 1 with the problems if it is not valid.
//   file <findings.json> [--dry-run]
//       Open an issue for every new finding (filings.js). Needs GH_TOKEN and
//       GITHUB_REPOSITORY; REVIEW_URL is linked from every issue;
//       DOCS_REVIEW_ASSIGNEES (comma-separated logins) are assigned every new
//       issue. --dry-run prints the plan and files nothing.
//
// A finding about a page that does not exist in the checkout is dropped with a
// line in the log rather than failing the run: one misremembered path should
// not cost the other findings their issues.

import { existsSync, readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { validateReport } from './findings.js';
import { describePlan, executeFilings, ISSUE_LABEL, planFilings } from './filings.js';
import { createGitHubClient } from '../securityReview/github.js';

const USAGE = 'usage: cli.js validate <findings.json> | file <findings.json> [--dry-run]';

export const defaultDeps = {
  readFile: p => readFileSync(p, 'utf8'),
  exists: p => existsSync(p),
  env: process.env,
  createClient: createGitHubClient,
  log: console.log,
};

function load(path, deps) {
  let parsed;
  try {
    parsed = JSON.parse(deps.readFile(path));
  } catch (err) {
    return { ok: false, problems: [`${path} is not readable JSON: ${err.message}`] };
  }
  return validateReport(parsed);
}

function onExistingPages(findings, deps) {
  const kept = [];
  for (const f of findings) {
    if (deps.exists(f.docPath)) kept.push(f);
    else deps.log(`${f.id} dropped: ${f.docPath} does not exist`);
  }
  return kept;
}

async function fileCommand(report, dryRun, deps) {
  const { GH_TOKEN, GITHUB_REPOSITORY, REVIEW_URL = '', DOCS_REVIEW_ASSIGNEES = '' } = deps.env;
  const assignees = DOCS_REVIEW_ASSIGNEES.split(',').map(s => s.trim()).filter(Boolean);
  const client = deps.createClient({ token: GH_TOKEN, repo: GITHUB_REPOSITORY, issueLabel: ISSUE_LABEL });
  const plan = planFilings(onExistingPages(report.findings, deps), await client.listIssues());
  const filed = dryRun ? {} : await executeFilings(plan, client, REVIEW_URL, { assignees });
  describePlan(plan, filed).forEach(line => deps.log(line));
  deps.log(`${Object.keys(filed).length} new issues${dryRun ? ' (dry run: nothing filed)' : ''}; reviewed ${report.checked.length} areas`);
  return 0;
}

export async function main(argv, deps = defaultDeps) {
  const [command, findingsPath, flag] = argv;
  if (!['validate', 'file'].includes(command) || !findingsPath) {
    deps.log(USAGE);
    return 2;
  }
  const result = load(findingsPath, deps);
  if (!result.ok) {
    result.problems.forEach(p => deps.log(`invalid: ${p}`));
    return 1;
  }
  if (command === 'validate') {
    deps.log(`${findingsPath} is valid: ${result.report.findings.length} findings`);
    return 0;
  }
  return fileCommand(result.report, flag === '--dry-run', deps);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => process.exit(code), err => { console.error(err.message); process.exit(1); });
}
