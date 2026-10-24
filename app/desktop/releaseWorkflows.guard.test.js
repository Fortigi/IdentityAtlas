// Guards for the cut-* release workflows that only show up when a real release
// is cut, so they are checked statically over the workflow text (see
// portableReleaseAssets.guard.test.js for the same approach).
//
// - The docs are deployed by docs.yml when a release is published. A cut-*
//   workflow that also runs mike pushes gh-pages at the same moment, and one of
//   the two pushes is rejected (seen cutting v5.9.2).
// - Nothing is released that is not on main (v6.0.1 was cut before its PR was
//   approved). Every cut-* workflow must run tools/release/Assert-ReleaseFromMain.ps1
//   before the tag is pushed — loaded from the workflow's own commit, so the ref
//   being released cannot swap in an edited copy — and only when run from main.
// - cut-hotfix runs main's copy of the workflow against an older branch, which
//   may lack the scripts it calls. It must find that out before pushing the tag,
//   or the run leaves a tag and Docker images behind with no GitHub release.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(repoRoot, p), 'utf8').replace(/\r\n/g, '\n');

// One chunk per step, so text in a neighbouring step cannot satisfy this one.
const steps = (yaml) => yaml.split(/\n(?=      - (?:name|uses): )/).slice(1);
const runsMike = (step) => step.split('\n').some((l) => /^\s+(?:[^#\s].*)?\bmike (?:deploy|set-default)\b/.test(l));

describe('docs are deployed by docs.yml alone', () => {
  it.each(['cut-release.yml', 'cut-beta.yml', 'cut-hotfix.yml'])('%s does not run mike', (file) => {
    expect(steps(read(`.github/workflows/${file}`)).filter(runsMike)).toEqual([]);
  });

  it('docs.yml deploys stable when a release is published', () => {
    const docs = read('.github/workflows/docs.yml');
    expect(docs).toMatch(/release:\n\s+types: \[published\]/);
    const deploy = steps(docs).filter(runsMike).filter((s) => s.includes("github.event_name == 'release'"));
    expect(deploy).toHaveLength(1);
    expect(deploy[0]).toMatch(/mike deploy --push --update-aliases --title "\$VERSION" stable "\$VERSION"/);
  });
});

describe('every cut-* workflow refuses code that is not on main', () => {
  it.each([
    ['cut-release.yml', 'Release'],
    ['cut-beta.yml', 'Release'],
    ['cut-hotfix.yml', 'Hotfix'],
  ])('%s runs the checker in %s mode before pushing the tag', (file, mode) => {
    const all = steps(read(`.github/workflows/${file}`));
    const gate = all.findIndex((s) => /Assert-ReleaseFromMain\.ps1/.test(s));
    const tag = all.findIndex((s) => /git push origin "\$TAG"/.test(s));
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(tag).toBeGreaterThan(gate);
    const step = all[gate];
    expect(step).toMatch(/git show "\$GITHUB_WORKFLOW_SHA:tools\/release\/Assert-ReleaseFromMain\.ps1" > "\$RUNNER_TEMP\/assert\.ps1"/);
    expect(step).toMatch(new RegExp(`pwsh -NoProfile -File "\\$RUNNER_TEMP/assert\\.ps1" -Mode ${mode} -Ref HEAD\\n`));
    expect(step).toMatch(/if \[ "\$GITHUB_REF" != "refs\/heads\/main" \]; then\n.*exit 1/);
    // Not softened into a warning that lets the run carry on.
    expect(step).not.toMatch(/continue-on-error|\|\| true/);
  });
});

// The Azure template package (IdentityAtlas-azure-<version>.zip) pins the
// template to the images of the release it ships with. The version it stamps
// must be the tag docker-publish pushes for that release — X.Y.Z.0 for a
// release, the version itself for a pre-release — or the package deploys an
// image that does not exist.
describe('every cut-* workflow ships the Azure template pinned to its own images', () => {
  it.each([
    ['cut-release.yml', '${VERSION}.0'],
    ['cut-hotfix.yml', '${VERSION}.0'],
    ['cut-beta.yml', '${VERSION}'],
  ])('%s packages it for image version %s and attaches it', (file, imageVersion) => {
    const all = steps(read(`.github/workflows/${file}`));
    const pack = all.findIndex((s) => s.includes('New-AzureTemplatePackage.ps1'));
    const publish = all.findIndex((s) => s.includes('gh release create'));
    expect(pack).toBeGreaterThanOrEqual(0);
    expect(publish).toBeGreaterThan(pack);

    const step = all[pack];
    // Main's copy, so an older hotfix branch without the script is still packaged.
    expect(step).toMatch(/git show "\$GITHUB_WORKFLOW_SHA:tools\/release\/New-AzureTemplatePackage\.ps1" > "\$RUNNER_TEMP\/package-azure\.ps1"/);
    const version = step.match(/-Version "([^"]+)"/)?.[1];
    expect(version).toBe(imageVersion);
    const out = step.match(/-OutFile "([^"]+)"/)?.[1];
    expect(out).toBe('$RUNNER_TEMP/IdentityAtlas-azure-${VERSION}.zip');

    // Attached only when written: a template from before imageTag gets none,
    // and that must not fail the release.
    expect(all[publish]).toContain(`if [ -f "${out}" ]; then\n            ASSETS+=("${out}")`);
  });

  it('stamps the same image tags docker-publish pushes', () => {
    const publish = read('.github/workflows/docker-publish.yml');
    expect(publish).toMatch(/Stable release tag: v5\.2\.0 → version 5\.2\.0\.0\n\s+VERSION="\$\{REF#v\}\.0"/);
    expect(publish).toMatch(/Pre-release tag: v5\.2\.0-beta\.1 → version 5\.2\.0-beta\.1 \(no \.0 suffix\)\n\s+VERSION="\$\{REF#v\}"/);
  });
});

describe('cut-hotfix checks the branch before tagging it', () => {
  const all = steps(read('.github/workflows/cut-hotfix.yml'));
  const check = all.findIndex((s) => s.startsWith('      - name: Check the branch has the files this workflow calls'));
  const tag = all.findIndex((s) => /git push origin "\$TAG"/.test(s));
  // Files read with `git show "$GITHUB_WORKFLOW_SHA:<path>"` come from main's
  // commit, not from the branch, so the branch need not have them.
  const repoFiles = (text) => new Set(text.match(/(?<!_SHA:)(?:\.github\/scripts|tools)\/[\w./-]+\.\w+/g) ?? []);

  it('runs the check before the tag is pushed', () => {
    expect(check).toBeGreaterThanOrEqual(0);
    expect(tag).toBeGreaterThan(check);
  });

  it('checks every repo file a later step calls', () => {
    const checked = repoFiles(all[check]);
    const called = new Set(all.slice(check + 1).flatMap((s) => [...repoFiles(s)]));
    expect(called.size).toBeGreaterThan(0);
    expect([...called].filter((f) => !checked.has(f))).toEqual([]);
  });

  it('does not count main-loaded files as branch files', () => {
    expect([...repoFiles('git show "$GITHUB_WORKFLOW_SHA:tools/release/x.ps1" && bash tools/y.sh')]).toEqual(['tools/y.sh']);
  });

  it('fails the run when a file is missing', () => {
    expect(all[check]).toMatch(/if \[ ! -f "\$f" \]/);
    expect(all[check]).toMatch(/exit \$missing/);
  });
});
