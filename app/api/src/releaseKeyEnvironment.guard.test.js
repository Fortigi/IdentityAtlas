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

// A job that calls a reusable workflow (`uses:`) runs no steps, so naming the key
// under its `secrets:` only hands the reference on; it resolves in the called job
// that names the environment (#1720). Those jobs are checked separately below.
function withoutPassedSecrets(job) {
  return job?.uses ? { ...job, secrets: undefined } : job;
}

/** Every job in the given workflow sources that reads the release App key. */
function jobsReadingReleaseKey(sources) {
  return sources.flatMap(({ file, text }) => {
    const jobs = parse(text)?.jobs ?? {};
    return Object.entries(jobs)
      .filter(([, job]) => READS_RELEASE_KEY.test(JSON.stringify(withoutPassedSecrets(job))))
      .map(([id, job]) => ({
        id: `${file} → ${id}`,
        file,
        environment: environmentName(job),
        runsOn: JSON.stringify(job['runs-on'] ?? null),
      }));
  });
}

/** Calls that hand the key to a reusable workflow: `{ id, uses, value }`. */
function jobsPassingReleaseKey(sources) {
  return sources.flatMap(({ file, text }) =>
    Object.entries(parse(text)?.jobs ?? {})
      .filter(([, job]) => job?.uses && READS_RELEASE_KEY.test(JSON.stringify(job.secrets ?? {})))
      .map(([id, job]) => ({ id: `${file} → ${id}`, uses: job.uses, value: job.secrets?.BOT_PRIVATE_KEY ?? null })));
}

/**
 * Where the key goes missing. A workflow whose job reads the key, or that passes it
 * on, must declare it as a required `workflow_call` secret when it can be called;
 * and every call to a workflow that declares it must pass it. Without both, the
 * key is an empty string at runtime and nothing fails until the release (#1720).
 */
function releaseKeyChainGaps(sources) {
  const byFile = new Map(sources.map(({ file, text }) => [file, parse(text) ?? {}]));
  const declares = new Set();
  const gaps = [];
  for (const [file, wf] of byFile) {
    const call = wf.on?.workflow_call;
    if (!call) continue;
    const needsKey = Object.values(wf.jobs ?? {}).some((job) => READS_RELEASE_KEY.test(JSON.stringify(job)));
    const declared = call.secrets?.BOT_PRIVATE_KEY;
    if (declared) declares.add(file);
    if (needsKey && declared?.required !== true) gaps.push(`${file} uses the key but does not declare it as a required workflow_call secret`);
  }
  for (const [file, wf] of byFile) {
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      const target = typeof job?.uses === 'string' && job.uses.startsWith('./.github/workflows/')
        ? job.uses.slice('./.github/workflows/'.length) : null;
      if (target && declares.has(target) && !job.secrets?.BOT_PRIVATE_KEY) gaps.push(`${file} → ${id} calls ${target} without passing BOT_PRIVATE_KEY`);
    }
  }
  return gaps;
}

const workflowSources = readdirSync(WORKFLOW_DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((file) => ({ file, text: readFileSync(join(WORKFLOW_DIR, file), 'utf8') }));

const ACTIONS_DIR = join(findCheckoutRoot(), '.github', 'actions');
const actionSources = readdirSync(ACTIONS_DIR, { recursive: true })
  .map(String)
  .filter((f) => /(^|[\\/])action\.ya?ml$/.test(f))
  .map((file) => ({ file, text: readFileSync(join(ACTIONS_DIR, file), 'utf8') }));

describe('the release App key is only read from its environment', () => {
  const jobs = jobsReadingReleaseKey(workflowSources);

  it('finds the jobs it is meant to guard', () => {
    // A guard that matches nothing passes vacuously; fail loudly if the workflows
    // are restructured so that the scan no longer sees them.
    expect(jobs.map((j) => j.file)).toEqual(
      // cut-tag.yml is the shared body of cut-release / cut-hotfix / cut-beta.
      expect.arrayContaining(['bump-version.yml', 'cut-tag.yml', 'ps-module-updates.yml']),
    );
  });

  it('no composite action names the key', () => {
    // A composite action has no environment of its own; the key reaches one
    // only as an input from a job, which is where this guard looks.
    expect(actionSources.length).toBeGreaterThan(0);
    expect(actionSources.filter(({ text }) => /\bBOT_PRIVATE_KEY\b/.test(text)).map(({ file }) => file)).toEqual([]);
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

  it('passes the key only to this repo\'s own workflows, by its own name', () => {
    const passing = jobsPassingReleaseKey(workflowSources);
    // Anchor: the release chain passes it, so the check below is not vacuous.
    expect(passing.map((j) => j.id)).toEqual(expect.arrayContaining([
      'cut-beta.yml → cut-beta', 'release-route.yml → cut-beta', 'release-weekly.yml → beta',
    ]));
    for (const j of passing) {
      expect(j.uses, `${j.id} hands the key to a workflow outside this repo`).toMatch(/^\.\/\.github\/workflows\//);
      expect(j.value, `${j.id} must pass the key as BOT_PRIVATE_KEY, unrenamed`).toBe('${{ secrets.BOT_PRIVATE_KEY }}');
    }
  });

  it('the key reaches every job that reads it through the whole call chain', () => {
    expect(releaseKeyChainGaps(workflowSources)).toEqual([]);
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

  it('does not count a reusable-workflow call that only passes the key on', () => {
    const found = jobsReadingReleaseKey(workflow({
      call: { uses: './.github/workflows/c.yml', secrets: { BOT_PRIVATE_KEY: '${{ secrets.BOT_PRIVATE_KEY }}' } },
      // `uses:` plus a read outside `secrets:` is still a read.
      sneaky: { uses: './.github/workflows/c.yml', with: { k: '${{ secrets.BOT_PRIVATE_KEY }}' } },
    }));
    expect(found.map((j) => j.id)).toEqual(['w.yml → sneaky']);
  });
});

describe('releaseKeyChainGaps', () => {
  const src = (file, doc) => ({ file, text: JSON.stringify(doc) });
  const reader = { 'runs-on': 'ubuntu-latest', environment: ENVIRONMENT, steps: [{ with: { 'private-key': '${{ secrets.BOT_PRIVATE_KEY }}' } }] };
  const pass = { BOT_PRIVATE_KEY: '${{ secrets.BOT_PRIVATE_KEY }}' };
  const called = (secrets) => src('called.yml', { on: { workflow_call: { secrets } }, jobs: { cut: reader } });

  it('accepts a chain that declares the key as required and passes it at every call', () => {
    expect(releaseKeyChainGaps([
      called({ BOT_PRIVATE_KEY: { required: true } }),
      src('mid.yml', { on: { workflow_call: { secrets: { BOT_PRIVATE_KEY: { required: true } } } }, jobs: { go: { uses: './.github/workflows/called.yml', secrets: pass } } }),
      src('top.yml', { on: { workflow_dispatch: {} }, jobs: { go: { uses: './.github/workflows/mid.yml', secrets: pass } } }),
    ])).toEqual([]);
  });

  it('flags a called workflow that reads the key without declaring it (the #1698 shape)', () => {
    expect(releaseKeyChainGaps([called({ BOT_APP_ID: { required: true } })]))
      .toEqual(['called.yml uses the key but does not declare it as a required workflow_call secret']);
  });

  it('flags a declaration that is optional, since optional resolves to empty without an error', () => {
    expect(releaseKeyChainGaps([called({ BOT_PRIVATE_KEY: { required: false } })])).toHaveLength(1);
  });

  it('flags a call that forgets to pass the key, and only that call', () => {
    expect(releaseKeyChainGaps([
      called({ BOT_PRIVATE_KEY: { required: true } }),
      src('top.yml', { jobs: {
        good: { uses: './.github/workflows/called.yml', secrets: pass },
        bad: { uses: './.github/workflows/called.yml', secrets: { BOT_APP_ID: '${{ secrets.BOT_APP_ID }}' } },
      } }),
    ])).toEqual(['top.yml → bad calls called.yml without passing BOT_PRIVATE_KEY']);
  });

  it('ignores a dispatch-only workflow that reads the key in its own job', () => {
    expect(releaseKeyChainGaps([src('solo.yml', { on: { workflow_dispatch: {} }, jobs: { cut: reader } })])).toEqual([]);
  });
});
