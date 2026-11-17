// Guards for the nightly release run and the security route
// (.github/workflows/release-nightly.yml, release-test.yml).
//
// These workflows only run on a schedule from main, so a wiring mistake would
// surface at 03:07 some night as a hotfix that should not have been cut — or as
// one that silently never is. The invariants that make the route safe are
// checked here, over the workflow files themselves:
//
//   * nothing reaches :latest unless its beta passed the release test;
//   * a dry run reaches Cut Beta / Cut Hotfix as a dry run;
//   * every job runs on a GitHub-hosted runner, never a self-hosted sidekick;
//   * the schedule is 02:07 UTC, off the hour GitHub delays.
//
// The decisions themselves (which fixes, which version, what a failure means)
// are PowerShell and unit-tested in test/unit/SecurityHotfix.Tests.ps1.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { repoRoot as findCheckoutRoot } from './lib/repoRoot.js';

const WORKFLOWS = join(findCheckoutRoot(), '.github', 'workflows');
const load = (file) => parse(readFileSync(join(WORKFLOWS, file), 'utf8'));
const nightly = load('release-nightly.yml');
const jobs = nightly.jobs;

describe('release-nightly.yml: when it runs', () => {
  it('runs at 02:07 UTC, off the hour', () => {
    expect(nightly.on.schedule).toEqual([{ cron: '7 2 * * *' }]);
  });

  it('is a dry run by default when started by hand, and never on the schedule', () => {
    expect(nightly.on.workflow_dispatch.inputs.dry_run).toMatchObject({ type: 'boolean', default: true });
    const mode = jobs['security-plan'].steps.find((s) => s.id === 'mode');
    expect(mode.env.DRY).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.dry_run }}");
  });
});

describe('release-nightly.yml: the security route', () => {
  it('builds the beta from the hotfix branch, in hotfix mode', () => {
    const beta = jobs['security-beta'];
    expect(beta.uses).toBe('./.github/workflows/cut-beta.yml');
    expect(beta.needs).toEqual(['security-plan', 'security-branch']);
    expect(beta.with).toMatchObject({ hotfix: true, ref: '${{ needs.security-plan.outputs.branch }}' });
  });

  it('tests that beta, with Azure, only once its images are published', () => {
    const test = jobs['security-test'];
    expect(test.uses).toBe('./.github/workflows/release-test.yml');
    expect(test.needs).toContain('security-images');
    expect(test.with).toEqual({ candidate: 'v${{ needs.security-plan.outputs.beta }}', azure: true });
    expect(jobs['security-images'].needs).toContain('security-beta');
  });

  it('cuts the hotfix only after a green release test (or a dry run, which has no beta to test)', () => {
    const hotfix = jobs['security-hotfix'];
    expect(hotfix.uses).toBe('./.github/workflows/cut-hotfix.yml');
    expect(hotfix.needs).toEqual(expect.arrayContaining(['security-beta', 'security-test']));
    const cond = hotfix.if.replace(/\s+/g, ' ');
    expect(cond).toContain("needs.security-beta.result == 'success'");
    expect(cond).toContain("needs.security-test.result == 'success'");
    // The only way past a test that did not pass is a skipped test in a dry run.
    expect(cond).toContain("(needs.security-plan.outputs.dry_run == 'true' && needs.security-test.result == 'skipped')");
    expect(cond).not.toMatch(/failure|cancelled|!= 'success'/);
  });

  it('skips the image wait in a dry run, since no tag was pushed', () => {
    expect(jobs['security-images'].if).toBe("needs.security-plan.outputs.dry_run != 'true'");
  });

  it.each(['security-beta', 'security-hotfix'])('%s passes the dry-run flag on to the Cut workflow', (id) => {
    expect(jobs[id].with.dry_run).toBe("${{ needs.security-plan.outputs.dry_run == 'true' }}");
    // Named secrets only; BOT_PRIVATE_KEY stays in the called job's environment.
    expect(Object.keys(jobs[id].secrets).sort()).toEqual(['BOT_APP_ID', 'CLAUDE_CODE_OAUTH_TOKEN']);
  });

  it('leaves deleting the branch and opening the issue to the finish step alone', () => {
    const text = readFileSync(join(WORKFLOWS, 'release-nightly.yml'), 'utf8');
    expect(text).not.toMatch(/push origin --delete|gh issue create|scheduled_failure_issue/);
    const finish = jobs['security-finish'];
    expect(finish.if).toBe("always() && needs.security-plan.outputs.needed == 'true'");
    expect(JSON.stringify(finish.steps)).toContain('Complete-SecurityHotfix.ps1');
  });

  it('hands every stage result to the finish step', () => {
    const results = jobs['security-finish'].steps.find((s) => s.env?.RESULTS).env.RESULTS;
    for (const stage of ['branch', 'beta', 'images', 'test', 'hotfix']) {
      expect(results).toContain(`"${stage}":"\${{ needs.security-${stage}.result }}"`);
    }
  });
});

describe('the release workflows never run on a self-hosted runner', () => {
  it.each(['release-nightly.yml', 'release-test.yml', 'dependabot-security-label.yml'])('%s', (file) => {
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

  it('names the group through the gate, with the candidate in it', () => {
    const name = test.jobs.azure.steps.find((s) => s.name === 'Name the resource group');
    expect(name.run).toContain('New-ReleaseTestGroupName');
    expect(name.run).toContain('ConvertTo-GroupNamePart $env:CANDIDATE');
  });
});
