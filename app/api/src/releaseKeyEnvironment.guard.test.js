// Hard-rule guard: the release App's private key is only readable from the
// `release-automation` environment.
//
// fortigi-ci-bot may push to main past the ruleset. Its key (BOT_PRIVATE_KEY) is a
// secret of the `release-automation` environment, which admits only runs on main or
// a release/* branch. A job that reads the key WITHOUT naming that environment gets
// the repository-level secret instead, and that one is handed to any workflow run on
// any same-repo branch, including a pull request that edits the workflow file to
// print it. So the repository-level secret must not exist, and it can only be
// deleted while no job depends on it.
//
// That is exactly what regressed once already: the key was moved into the
// environment, and a workflow added in the same week read it the old way. Nothing
// fails at runtime while the repository-level secret is still there, so the
// invariant is enforced statically, over the workflow files themselves — the same
// shape as updates/imageVersionStamp.guard.test.js.
//
// The job list is DERIVED from the workflows, not hand-listed, so a new job that
// uses the key is under the guard automatically.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { repoRoot as findCheckoutRoot } from './lib/repoRoot.js';

const WORKFLOW_DIR = join(findCheckoutRoot(), '.github', 'workflows');
const ENVIRONMENT = 'release-automation';

// `secrets.BOT_PRIVATE_KEY` exactly: `secrets.DOR_BOT_PRIVATE_KEY` is the other App,
// which has no bypass and is meant to be readable by the DoR jobs.
const READS_RELEASE_KEY = /secrets\.BOT_PRIVATE_KEY\b/;

/** `environment:` is either a name or `{ name, url }`. */
function environmentName(job) {
  const env = job?.environment;
  return typeof env === 'string' ? env : env?.name ?? null;
}

/** Every job in the given workflow sources that reads the release App key. */
function jobsReadingReleaseKey(sources) {
  return sources.flatMap(({ file, text }) => {
    const jobs = parse(text)?.jobs ?? {};
    return Object.entries(jobs)
      .filter(([, job]) => READS_RELEASE_KEY.test(JSON.stringify(job)))
      .map(([id, job]) => ({
        id: `${file} → ${id}`,
        file,
        environment: environmentName(job),
        runsOn: JSON.stringify(job['runs-on'] ?? null),
      }));
  });
}

const workflowSources = readdirSync(WORKFLOW_DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((file) => ({ file, text: readFileSync(join(WORKFLOW_DIR, file), 'utf8') }));

describe('the release App key is only read from its environment', () => {
  const jobs = jobsReadingReleaseKey(workflowSources);

  it('finds the jobs it is meant to guard', () => {
    // A guard that matches nothing passes vacuously; fail loudly if the workflows
    // are restructured so that the scan no longer sees them.
    expect(jobs.map((j) => j.file)).toEqual(
      expect.arrayContaining(['bump-version.yml', 'cut-release.yml', 'cut-hotfix.yml', 'ps-module-updates.yml']),
    );
  });

  it.each(jobs)('$id runs in the release-automation environment', (job) => {
    expect(job.environment, `${job.id} reads secrets.BOT_PRIVATE_KEY without "environment: ${ENVIRONMENT}"`).toBe(ENVIRONMENT);
  });

  it.each(jobs)('$id runs on a GitHub-hosted runner', (job) => {
    // The key must never reach a self-hosted sidekick: whoever controls the box
    // could then push to main.
    expect(job.runsOn).toMatch(/^"(ubuntu|windows|macos)-/);
  });

  it('no workflow reads the key outside a job, where no environment applies', () => {
    // Workflow-level `env:` is evaluated without the job's environment.
    const offenders = workflowSources
      .filter(({ text }) => READS_RELEASE_KEY.test(JSON.stringify({ ...parse(text), jobs: undefined })))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('no caller hands all its secrets to a reusable workflow', () => {
    // `secrets: inherit` would pass the key along without the text ever naming it.
    const inheriting = workflowSources.flatMap(({ file, text }) =>
      Object.entries(parse(text)?.jobs ?? {})
        .filter(([, job]) => job?.secrets === 'inherit')
        .map(([id]) => `${file} → ${id}`));
    expect(inheriting).toEqual([]);
  });
});

describe('jobsReadingReleaseKey', () => {
  const workflow = (jobs) => [{ file: 'w.yml', text: JSON.stringify({ jobs }) }];
  const mint = (secret) => ({ steps: [{ with: { 'private-key': `\${{ secrets.${secret} }}` } }] });

  it('reports a job that reads the key, with the environment it names', () => {
    const found = jobsReadingReleaseKey(workflow({
      bare: { 'runs-on': 'ubuntu-latest', ...mint('BOT_PRIVATE_KEY') },
      named: { 'runs-on': 'ubuntu-latest', environment: ENVIRONMENT, ...mint('BOT_PRIVATE_KEY') },
      object: { 'runs-on': 'ubuntu-latest', environment: { name: 'other', url: 'https://x' }, ...mint('BOT_PRIVATE_KEY') },
    }));
    expect(found.map((j) => [j.id, j.environment])).toEqual([
      ['w.yml → bare', null],
      ['w.yml → named', ENVIRONMENT],
      ['w.yml → object', 'other'],
    ]);
  });

  it('ignores the DoR App key and jobs that read no key', () => {
    const found = jobsReadingReleaseKey(workflow({
      dor: { 'runs-on': ['self-hosted', 'dor-build'], ...mint('DOR_BOT_PRIVATE_KEY') },
      plain: { 'runs-on': 'ubuntu-latest', steps: [{ run: 'echo BOT_PRIVATE_KEY' }] },
    }));
    expect(found).toEqual([]);
  });

  it('reads the key in a ternary that also names the DoR key', () => {
    const found = jobsReadingReleaseKey(workflow({
      both: { 'runs-on': 'ubuntu-latest', steps: [{ with: { 'private-key': "${{ matrix.app == 'dor' && secrets.DOR_BOT_PRIVATE_KEY || secrets.BOT_PRIVATE_KEY }}" } }] },
    }));
    expect(found.map((j) => j.id)).toEqual(['w.yml → both']);
  });

  it('a workflow without jobs yields nothing', () => {
    expect(jobsReadingReleaseKey([{ file: 'empty.yml', text: 'name: x\n' }])).toEqual([]);
  });
});
