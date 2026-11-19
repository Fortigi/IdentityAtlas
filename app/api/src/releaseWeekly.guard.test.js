// Guards for the weekly release run and its two routes
// (.github/workflows/release-weekly.yml, release-route.yml, release-test.yml).
//
// These workflows only run on a schedule from main, so a wiring mistake would
// surface at 03:07 some Tuesday as a stable release that should not have been
// cut — or as one that silently never is. The invariants that make the routes
// safe are checked here, over the workflow files themselves:
//
//   * nothing reaches :latest unless its beta passed the release test, and the
//     stable release is the very commit that beta was cut from;
//   * only the stable route promotes; a new minor goes stable by hand;
//   * a dry run reaches Cut Beta / Cut Hotfix as a dry run;
//   * every job runs on a GitHub-hosted runner, never a self-hosted sidekick;
//   * the schedule is once a week, Tuesday 02:07 UTC, off the hour GitHub delays.
//
// The decisions themselves (what to cut, which version, Azure or not, what a
// failure means) are PowerShell, unit-tested in test/unit/ReleaseWeekly.Tests.ps1
// and test/unit/ReleaseRoute.Tests.ps1.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { parse } from 'yaml';
import { repoRoot as findCheckoutRoot } from './lib/repoRoot.js';

const WORKFLOWS = join(findCheckoutRoot(), '.github', 'workflows');
const load = (file) => parse(readFileSync(join(WORKFLOWS, file), 'utf8'));
const weekly = load('release-weekly.yml');
const jobs = weekly.jobs;
const route = load('release-route.yml');
const steps = route.jobs;

describe('release-weekly.yml: when it runs', () => {
  it('runs once a week, Tuesday 02:07 UTC, off the hour', () => {
    expect(weekly.on.schedule).toEqual([{ cron: '7 2 * * 2' }]);
  });

  it('is a dry run by default when started by hand, and never on the schedule', () => {
    expect(weekly.on.workflow_dispatch.inputs.dry_run).toMatchObject({ type: 'boolean', default: true });
    const mode = jobs.plan.steps.find((s) => s.id === 'mode');
    expect(mode.env.DRY).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.dry_run }}");
  });

  it('checks out every branch and tag, so the plan sees release/X.Y', () => {
    const checkout = jobs.plan.steps.find((s) => String(s.uses).startsWith('actions/checkout@'));
    expect(checkout.with['fetch-depth']).toBe(0);
  });
});

describe('release-weekly.yml: the two routes', () => {
  it('the stable route cuts the release line\'s beta in hotfix mode and promotes the next patch', () => {
    const stable = jobs.stable;
    expect(stable.uses).toBe('./.github/workflows/release-route.yml');
    expect(stable.if).toBe("needs.plan.outputs.stable_needed == 'true'");
    expect(stable.with).toMatchObject({
      route: 'stable',
      version: '${{ needs.plan.outputs.stable_beta }}',
      ref: '${{ needs.plan.outputs.stable_sha }}',
      hotfix: true,
      promote: '${{ needs.plan.outputs.stable_version }}',
    });
  });

  it('the beta route cuts a beta of main and promotes nothing', () => {
    const beta = jobs.beta;
    expect(beta.uses).toBe('./.github/workflows/release-route.yml');
    expect(beta.if).toBe("needs.plan.outputs.beta_needed == 'true'");
    expect(beta.with).toMatchObject({ route: 'beta', ref: '${{ needs.plan.outputs.beta_sha }}', hotfix: false, promote: '' });
  });

  it.each(['stable', 'beta'])('the %s route gets Azure only when the plan says so, and the dry-run flag as planned', (id) => {
    expect(jobs[id].with.azure).toBe(`\${{ needs.plan.outputs.${id}_azure == 'true' }}`);
    expect(jobs[id].with.dry_run).toBe("${{ needs.plan.outputs.dry_run == 'true' }}");
    // Named secrets only; BOT_PRIVATE_KEY stays in the called job's environment.
    expect(Object.keys(jobs[id].secrets).sort()).toEqual(['BOT_APP_ID', 'CLAUDE_CODE_OAUTH_TOKEN']);
  });

  it('cuts from commit SHAs the plan resolved, never from a branch name that can move', () => {
    // ConvertTo-RouteOutput (unit-tested) turns each route's resolved SHA into <name>_sha.
    const plan = readFileSync(join(findCheckoutRoot(), 'tools', 'release', 'Get-WeeklyPlan.ps1'), 'utf8');
    expect(plan).toContain("ConvertTo-RouteOutput -Name stable -Plan $stableRoute.Plan -Sha $stableRoute.Sha -Keys @('Version', 'Beta')");
    expect(plan).toContain('ConvertTo-RouteOutput -Name beta -Plan $betaRoute.Plan -Sha $betaRoute.Sha');
    expect(plan).toMatch(/\$sha = \(& git rev-parse --verify --quiet "\$branch\^\{commit\}"\)/);
    expect(plan).toMatch(/\$mainSha = \(Invoke-Git rev-parse "\$Main\^\{commit\}"\)/);
    for (const id of ['stable', 'beta']) {
      expect(jobs.plan.outputs[`${id}_sha`]).toBe(`\${{ steps.plan.outputs.${id}_sha }}`);
    }
  });

  it('tests an existing candidate only when one is planned', () => {
    expect(jobs['release-test'].if).toBe("needs.plan.outputs.candidate != ''");
  });
});

describe('release-route.yml: from beta to verdict', () => {
  it('is only ever called, never started on its own', () => {
    expect(Object.keys(route.on)).toEqual(['workflow_call']);
    expect(route.on.workflow_call.inputs.dry_run.default).toBe(true);
  });

  it('cuts the beta from the given commit, in the given mode, passing dry_run on', () => {
    expect(steps['cut-beta'].uses).toBe('./.github/workflows/cut-beta.yml');
    expect(steps['cut-beta'].with).toEqual({
      version: '${{ inputs.version }}', ref: '${{ inputs.ref }}', hotfix: '${{ inputs.hotfix }}', dry_run: '${{ inputs.dry_run }}',
    });
  });

  it('tests that beta only once its images are published, and skips the wait in a dry run', () => {
    expect(steps.images.needs).toBe('cut-beta');
    expect(steps.images.if).toBe('${{ !inputs.dry_run }}');
    expect(steps.test.uses).toBe('./.github/workflows/release-test.yml');
    expect(steps.test.needs).toBe('images');
    expect(steps.test.with).toEqual({ candidate: 'v${{ inputs.version }}', azure: '${{ inputs.azure }}' });
  });

  it('promotes the same commit, only after a green test (or a dry run, which has no beta to test)', () => {
    const promote = steps.promote;
    expect(promote.uses).toBe('./.github/workflows/cut-hotfix.yml');
    expect(promote.with).toMatchObject({ branch: '${{ inputs.ref }}', version: '${{ inputs.promote }}', dry_run: '${{ inputs.dry_run }}' });
    const cond = promote.if.replace(/\s+/g, ' ');
    expect(cond).toContain("inputs.promote != ''");
    expect(cond).toContain("needs.cut-beta.result == 'success'");
    expect(cond).toContain("needs.test.result == 'success'");
    // The only way past a test that did not pass is a skipped test in a dry run.
    expect(cond).toContain("(inputs.dry_run && needs.test.result == 'skipped')");
    expect(cond).not.toMatch(/failure|cancelled|!= 'success'/);
  });

  it('leaves the issue to the finish step, and hands it every stage result', () => {
    const text = readFileSync(join(WORKFLOWS, 'release-route.yml'), 'utf8');
    expect(text).not.toMatch(/gh issue create|scheduled_failure_issue|push origin --delete/);
    const finish = steps.finish;
    expect(finish.if).toBe('always()');
    const run = finish.steps.find((s) => s.env?.RESULTS);
    expect(run.run).toContain('Complete-WeeklyRoute.ps1');
    for (const [stage, job] of [['beta', 'cut-beta'], ['images', 'images'], ['test', 'test'], ['release', 'promote']]) {
      expect(run.env.RESULTS).toContain(`"${stage}":"\${{ needs.${job}.result }}"`);
    }
  });
});

describe('the security-only route is gone', () => {
  it('no workflow labels or looks up security fixes any more', () => {
    expect(existsSync(join(WORKFLOWS, 'dependabot-security-label.yml'))).toBe(false);
    for (const file of ['release-weekly.yml', 'release-route.yml']) {
      expect(readFileSync(join(WORKFLOWS, file), 'utf8')).not.toMatch(/security-fix|SECURITY_LOOKUP|security-hotfix/);
    }
  });
});

describe('the release workflows never run on a self-hosted runner', () => {
  it.each(['release-weekly.yml', 'release-route.yml', 'release-test.yml'])('%s', (file) => {
    for (const [id, job] of Object.entries(load(file).jobs)) {
      if (job.uses) continue;   // a reusable workflow: its own jobs are checked here too
      expect(JSON.stringify(job['runs-on']), `${file} → ${id}`).toMatch(/^"(ubuntu|windows)-latest"$/);
    }
  });
});

describe('release-test.yml: Azure', () => {
  const test = load('release-test.yml');

  it('only the Azure and sign-in jobs use the azure-release-test environment, and none runs on a PR', () => {
    const inEnv = Object.entries(test.jobs).filter(([, j]) => j.environment === 'azure-release-test').map(([id]) => id);
    expect(inEnv.sort()).toEqual(['azure', 'azure-sweep', 'docker-signin']);
    for (const id of inEnv) expect(test.jobs[id].if).toContain("github.event_name != 'pull_request'");
  });

  it('deletes the resource group whatever happened', () => {
    const del = test.jobs.azure.steps.find((s) => s.name === 'Delete the resource group');
    expect(del.if).toBe('always()');
    expect(del.run).toContain('Remove-ReleaseTestGroup -Name $env:GROUP');
  });

  // Runs the sign-in job's variable check itself: a static look can't tell
  // `${!v%%:*}` (a bash error that failed the job with every variable set)
  // from working shell.
  describe('the sign-in variable check', () => {
    const job = test.jobs['docker-signin'];
    const check = job.steps.find((s) => s.name === 'Check the sign-in variables are set');
    const scenario = job.steps.find((s) => s.name === 'Run the sign-in scenario');
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const bash = process.platform === 'win32' ? (existsSync(gitBash) ? gitBash : null) : 'bash';
    // The same shell GitHub uses for a `run:` step.
    const runCheck = (env) => spawnSync(bash, ['--noprofile', '--norc', '-eo', 'pipefail', '-c', check.run], {
      env: { PATH: process.env.PATH, ...env }, encoding: 'utf8',
    });
    const all = Object.fromEntries(Object.keys(check.env).map((k) => [k, `value-of-${k}`]));

    it('checks exactly the variables the sign-in scenario uses', () => {
      expect(check.env).toEqual(scenario.env);
    });

    it.skipIf(!bash)('passes when every variable is set', () => {
      const r = runCheck(all);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    });

    it.skipIf(!bash)('fails naming only the missing variables', () => {
      const r = runCheck({ ...all, SSO: '', NOROLE: undefined });
      expect(r.status).toBe(1);
      expect(r.stderr).toBe('');
      expect(r.stdout).toContain('environment: RELEASE_TEST_SSO_CLIENT_ID RELEASE_TEST_NOROLE_CLIENT_ID (');
      expect(r.stdout).not.toMatch(/AZURE_TENANT_ID|AZURE_CLIENT_ID/);
    });

    it.skipIf(!bash)('names every variable in its env block when none is set', () => {
      const r = runCheck({});
      expect(r.status).toBe(1);
      for (const expr of Object.values(check.env)) {
        expect(r.stdout).toContain(` ${expr.match(/vars\.(\w+)/)[1]}`);
      }
    });
  });

  it('names the group through the gate, with the candidate in it', () => {
    const name = test.jobs.azure.steps.find((s) => s.name === 'Name the resource group');
    expect(name.run).toContain('New-ReleaseTestGroupName');
    expect(name.run).toContain('ConvertTo-GroupNamePart $env:CANDIDATE');
  });
});
