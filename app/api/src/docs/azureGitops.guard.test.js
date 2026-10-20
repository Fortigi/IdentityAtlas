// Guards for the "Azure as code" examples (azure/gitops/, docs/architecture/azure-gitops.md).
//
// They run in a customer's repository, not here, so nothing in this repo would
// notice them drifting from what a release actually ships. Each check below ties
// an example to the thing it depends on:
//
//   - the update workflow downloads the package under the name the cut-*
//     workflows attach it with, and compares against the version the packager
//     stamps into RELEASE;
//   - the deploy workflow deploys the compiled template from the package;
//   - the example parameters file passes only parameters the template declares,
//     and never imageTag — a value there overrides the release's own pin, and
//     template and images can drift apart again.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';

const REPO = join(import.meta.dirname, '..', '..', '..', '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8').replace(/\r\n/g, '\n');

const UPDATE = 'azure/gitops/identity-atlas-update.yml';
const DEPLOY = 'azure/gitops/identity-atlas-deploy.yml';
const PARAMS = 'azure/gitops/parameters.production.example.json';
const PACKAGER = 'tools/release/New-AzureTemplatePackage.ps1';

const runOf = (job, name) => job.steps.find((s) => s.name === name)?.run ?? '';

describe('the update workflow', () => {
  const wf = parse(read(UPDATE));
  const job = wf.jobs['propose-upgrade'];

  it('is a valid workflow that runs on a schedule and on demand', () => {
    expect(wf.on.schedule).toHaveLength(1);
    expect(wf.on).toHaveProperty('workflow_dispatch');
    expect(wf.permissions).toEqual({ contents: 'write', 'pull-requests': 'write' });
  });

  it('downloads the package under the name every cut-* workflow attaches it with', () => {
    expect(runOf(job, 'Replace the template with the release\'s package')).toContain('ASSET="IdentityAtlas-azure-${VERSION}.zip"');
    for (const file of ['cut-release.yml', 'cut-hotfix.yml', 'cut-beta.yml']) {
      expect(read(`.github/workflows/${file}`), file).toContain('-OutFile "$RUNNER_TEMP/IdentityAtlas-azure-${VERSION}.zip"');
    }
  });

  it('compares against the image version a release package records in RELEASE', () => {
    const check = runOf(job, 'Compare with the latest release');
    // Stable releases only (gh release view = the latest non-pre-release), and
    // their packages are stamped X.Y.Z.0 by cut-release / cut-hotfix.
    expect(check).toContain('LATEST="${VERSION}.0"');
    expect(read('.github/workflows/cut-release.yml')).toContain('-Version "${VERSION}.0"');
    expect(read(PACKAGER)).toContain("Join-Path $target 'RELEASE'");
  });

  it('only proposes a newer release, never a downgrade', () => {
    const check = runOf(job, 'Compare with the latest release');
    expect(check).toMatch(/sort -V \| tail -n1/);
    expect(check).toContain('[ "$HIGHEST" != "$LATEST" ]');
  });

  it('replaces only the template folder, never the operator\'s parameters', () => {
    expect(wf.env.TEMPLATE_DIR).toBe('identity-atlas');
    const replace = runOf(job, 'Replace the template with the release\'s package');
    expect(replace).toContain('rm -rf "$TEMPLATE_DIR"');
    expect(replace).not.toMatch(/parameters/);
  });
});

describe('the deploy workflow', () => {
  const wf = parse(read(DEPLOY));

  it('runs the what-if on pull requests and deploys only after a merge, in an environment', () => {
    expect(wf.jobs['what-if'].if).toBe("github.event_name == 'pull_request'");
    expect(wf.jobs.deploy.if).toBe("github.event_name != 'pull_request'");
    expect(wf.jobs.deploy.environment).toBe('production');
    expect(wf.on.push.branches).toEqual(['main']);
  });

  it('deploys the compiled template from the same folder the update workflow writes', () => {
    expect(wf.env.TEMPLATE_DIR).toBe(parse(read(UPDATE)).env.TEMPLATE_DIR);
    for (const [job, step] of [['what-if', 'What would this change?'], ['deploy', 'Deploy']]) {
      const run = runOf(wf.jobs[job], step);
      expect(run, job).toContain('--template-file "$TEMPLATE_DIR/main.json"');
      expect(run, job).toContain('--parameters "@$PARAMETERS"');
    }
  });

  it('signs in with OpenID Connect, not a stored secret', () => {
    expect(wf.permissions['id-token']).toBe('write');
    expect(read(DEPLOY)).not.toMatch(/secrets\./);
  });
});

describe('the example parameters file', () => {
  const declared = Object.keys(JSON.parse(read('azure/main.json')).parameters);
  const given = Object.keys(JSON.parse(read(PARAMS)).parameters);

  it('passes only parameters the template declares', () => {
    expect(given.length).toBeGreaterThan(0);
    expect(given.filter((p) => !declared.includes(p))).toEqual([]);
  });

  it('configures sign-in in the template, so an upgrade does not clear it', () => {
    expect(given).toEqual(expect.arrayContaining(['entraTenantId', 'entraClientId']));
  });

  it.each([PARAMS, 'azure/main.parameters.example.json'])('%s does not set imageTag, which would override the release\'s own pin', (file) => {
    expect(Object.keys(JSON.parse(read(file)).parameters)).not.toContain('imageTag');
  });
});

describe('the guide', () => {
  it('is in the docs navigation next to the deployment reference', () => {
    expect(read('mkdocs.yml')).toMatch(/Azure Deployment Reference: architecture\/azure-deployment\.md\n\s+- Azure as Code \(GitOps\): architecture\/azure-gitops\.md/);
  });

  it('tells the reader not to set imageTag, and why sign-in belongs in the parameters', () => {
    const guide = read('docs/architecture/azure-gitops.md');
    expect(guide).toMatch(/Do \*\*not\*\* set `imageTag`/);
    expect(guide).toContain('entraTenantId');
  });
});
