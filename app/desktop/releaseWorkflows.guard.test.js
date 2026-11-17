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
    // Cut Beta checks a hotfix branch's beta the way Cut Hotfix checks the hotfix:
    // $MODE is Release unless `hotfix: true` (asserted below).
    ['cut-beta.yml', '"$MODE"'],
    ['cut-hotfix.yml', 'Hotfix'],
  ])('%s runs the checker in %s mode before pushing the tag', (file, mode) => {
    const all = steps(read(`.github/workflows/${file}`));
    const gate = all.findIndex((s) => /Assert-ReleaseFromMain\.ps1/.test(s));
    const tag = all.findIndex((s) => /git push origin "\$TAG"/.test(s));
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(tag).toBeGreaterThan(gate);
    const step = all[gate];
    expect(step).toMatch(/git show "\$GITHUB_WORKFLOW_SHA:tools\/release\/Assert-ReleaseFromMain\.ps1" > "\$RUNNER_TEMP\/assert\.ps1"/);
    expect(step).toContain(`pwsh -NoProfile -File "$RUNNER_TEMP/assert.ps1" -Mode ${mode} -Ref HEAD\n`);
    expect(step).toMatch(/if \[ "\$GITHUB_REF" != "refs\/heads\/main" \]; then\n.*exit 1/);
    // Not softened into a warning that lets the run carry on.
    expect(step).not.toMatch(/continue-on-error|\|\| true/);
  });

  it('cut-beta checks in Release mode unless asked for a hotfix branch, and in no other mode', () => {
    const gate = steps(read('.github/workflows/cut-beta.yml')).find((s) => /Assert-ReleaseFromMain\.ps1/.test(s));
    expect(gate).toContain('HOTFIX: ${{ inputs.hotfix }}');
    const modes = [...gate.matchAll(/MODE=(\w+)/g)].map((m) => m[1]);
    expect(modes).toEqual(['Release', 'Hotfix']);
    expect(gate).toMatch(/MODE=Release\n\s+if \[ "\$HOTFIX" = "true" \]; then MODE=Hotfix; fi/);
  });
});

// The nightly routes (release-route.yml) call Cut Beta and Cut Hotfix with dry_run. A dry
// run must leave nothing behind on GitHub: no tag (which would make
// docker-publish push images) and no release.
describe('a dry run of a cut-* workflow publishes nothing', () => {
  it.each(['cut-beta.yml', 'cut-hotfix.yml'])('%s pushes the tag only outside a dry run', (file) => {
    const tagStep = steps(read(`.github/workflows/${file}`)).find((s) => /git push origin "\$TAG"/.test(s));
    expect(tagStep).toContain('DRY_RUN: ${{ inputs.dry_run }}');
    expect(tagStep).toMatch(/if \[ "\$DRY_RUN" = "true" \]; then\n[^\n]*\n\s+else\n\s+git push origin "\$TAG"\n\s+fi/);
  });

  it.each(['cut-beta.yml', 'cut-hotfix.yml'])('%s creates the release only outside a dry run', (file) => {
    const release = steps(read(`.github/workflows/${file}`)).filter((s) => s.includes('gh release create'));
    expect(release).toHaveLength(1);
    expect(release[0]).toMatch(/^ {6}- name: [^\n]+\n {8}if: \$\{\{ !inputs\.dry_run \}\}\n/);
  });

  it.each(['cut-beta.yml', 'cut-hotfix.yml'])('%s reads its inputs from `inputs`, so workflow_call works', (file) => {
    const text = read(`.github/workflows/${file}`);
    expect(text).toMatch(/\n {2}workflow_call:\n/);
    expect(text).not.toContain('github.event.inputs');
  });
});

// docker-publish refuses a tag whose commit is not on main (F-52). A hotfix tag
// is not on main by construction, so it must be admitted by main's own checker
// — read from origin/main, never from the tag being published.
describe('docker-publish admits a hotfix only through main\'s checker', () => {
  const guard = steps(read('.github/workflows/docker-publish.yml')).find((s) => s.includes('Refuse a release tag that is not on main'));

  it('loads Assert-ReleaseFromMain.ps1 from origin/main and runs it in Hotfix mode', () => {
    expect(guard).toContain('git show "origin/main:tools/release/Assert-ReleaseFromMain.ps1" > "$RUNNER_TEMP/assert.ps1"');
    expect(guard).toContain('if pwsh -NoProfile -File "$RUNNER_TEMP/assert.ps1" -Mode Hotfix -Ref HEAD; then');
  });

  it('still refuses everything else', () => {
    expect(guard).toMatch(/exit 1\n?$/);
    expect(guard).not.toMatch(/continue-on-error|\|\| true/);
    expect(guard).not.toMatch(/git show "?\$?\{?REF|git show "HEAD:tools/);
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

// :beta is the preview of the next minor. The nightly stable route cuts patch
// betas of the release line (6.1.2-beta.1) as test candidates for :latest; if
// those moved :beta, everyone on :beta would go back a whole minor, onto a
// database the newer version had already migrated.
describe('docker-publish moves :beta only for a beta of a new minor', () => {
  const publish = read('.github/workflows/docker-publish.yml');
  const resolve = steps(publish).find((s) => s.includes("Resolve channel's floating tag"));

  it('floats :beta for X.Y.0 pre-releases only', () => {
    expect(resolve).toContain(String.raw`beta)    if [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.0- ]]; then FLOAT=beta; else FLOAT=; fi ;;`);
    expect(resolve).toContain('release) FLOAT=latest ;;');
  });

  it.each(['identity-atlas-web', 'identity-atlas-report-generator', 'identity-atlas-worker'])(
    '%s tags and pushes the floating tag only when there is one, and its version tag always',
    (image) => {
      const push = steps(publish).find((s) => s.includes(`docker tag ${image}:qa "$REPO:$VERSION"`));
      expect(push).toContain(`if [ -n "$FLOAT" ]; then docker tag ${image}:qa "$REPO:$FLOAT"; fi`);
      expect(push).toContain('if [ -n "$FLOAT" ]; then docker push "$REPO:$FLOAT"; fi');
      expect(push).toMatch(/\n\s+docker push "\$REPO:\$VERSION"\n/);
      expect(push).not.toMatch(/\n\s+docker push "\$REPO:\$FLOAT"\n/);
    },
  );
});

// Only the newest stable minor is maintained. Cut Release of X.Y.0 starts its
// line (release/X.Y) and moves Dependabot there through a PR into main — after
// the release exists, never instead of it.
describe('cut-release starts the release line for a new minor', () => {
  const all = steps(read('.github/workflows/cut-release.yml'));
  const line = all.findIndex((s) => s.includes('- name: Start the release line'));
  const release = all.findIndex((s) => s.includes('gh release create'));

  it('runs for X.Y.0 only, after the GitHub release is created', () => {
    expect(line).toBeGreaterThan(release);
    expect(all[line]).toContain("if: endsWith(github.event.inputs.version, '.0')");
  });

  it('creates release/X.Y from the tagged commit, leaving an existing one alone', () => {
    expect(all[line]).toContain('LINE="release/${VERSION%.*}"');
    expect(all[line]).toMatch(/if git ls-remote --exit-code --heads origin "\$LINE"[^\n]*; then\n[^\n]*already exists[^\n]*\n\s+else\n\s+git push origin "HEAD:refs\/heads\/\$LINE"/);
  });

  it('moves Dependabot through a pull request into main, not a push to main', () => {
    expect(all[line]).toContain('tools/release/Set-DependabotReleaseLine.ps1 -Line "$LINE"');
    expect(all[line]).toContain('gh pr create --base main --head "$PR_BRANCH"');
    expect(all[line]).not.toMatch(/push[^\n]*(refs\/heads\/main|origin main\b)/);
  });
});
