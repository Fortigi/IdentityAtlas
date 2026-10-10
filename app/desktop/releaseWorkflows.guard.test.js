// Guards for the cut-* release workflows that only show up when a real release
// is cut, so they are checked statically over the workflow text (see
// portableReleaseAssets.guard.test.js for the same approach).
//
// - The docs are deployed by docs.yml when a release is published. A cut-*
//   workflow that also runs mike pushes gh-pages at the same moment, and one of
//   the two pushes is rejected (seen cutting v5.9.2).
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

describe('cut-hotfix checks the branch before tagging it', () => {
  const all = steps(read('.github/workflows/cut-hotfix.yml'));
  const check = all.findIndex((s) => s.startsWith('      - name: Check the branch has the files this workflow calls'));
  const tag = all.findIndex((s) => /git push origin "\$TAG"/.test(s));
  const repoFiles = (text) => new Set(text.match(/(?:\.github\/scripts|tools)\/[\w./-]+\.\w+/g) ?? []);

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

  it('fails the run when a file is missing', () => {
    expect(all[check]).toMatch(/if \[ ! -f "\$f" \]/);
    expect(all[check]).toMatch(/exit \$missing/);
  });
});
