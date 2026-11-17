// Guard: every image we publish takes the OS security updates at build time, and
// carries no runtime pieces it does not use.
//
// Base images are pinned by digest (SEC-2026-09 M-14), so a rebuild never moves
// to a newer base on its own. That is deliberate, but it means the OS packages
// were only ever as fresh as the pinned digest. For the worker that was a
// Microsoft PowerShell image Microsoft stopped rebuilding (built 2025-01-30,
// PowerShell 7.5.0), so Dependabot had nothing to bump to. When the image CVE
// scan (image-scan.yml) arrived it reported ~500 findings: Ubuntu packages and
// PowerShell's bundled .NET libraries in the worker and report-generator, and
// npm's own bundled dependencies in the web image.
//
// The fixes are build-definition properties, so they are checked statically,
// the same way imageVersionStamp.guard.test.js checks the version stamp. The image
// list is derived from the publish workflow so a new image falls under the guard.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { repoRoot as findCheckoutRoot } from '../lib/repoRoot.js';

const repoRoot = findCheckoutRoot();
const read = (p) => readFileSync(join(repoRoot, p), 'utf8');

const WORKER = 'setup/docker/Dockerfile.powershell';
const WEB = 'app/api/Dockerfile';

// The stage that ships: everything after the last FROM. An upgrade in a build
// stage that is thrown away would patch nothing anyone runs.
function finalStage(dockerfile) {
  const froms = [...dockerfile.matchAll(/^FROM\s.*$/gm)];
  return dockerfile.slice(froms.at(-1).index);
}

// Each RUN instruction joined across its `\` continuations.
function runInstructions(stage) {
  return [...stage.matchAll(/^RUN\s((?:.*\\\n)*.*)$/gm)].map((m) => m[1]);
}

const publishedDockerfiles = [
  ...new Set([...read('.github/workflows/docker-publish.yml').matchAll(/^\s*file: \.\/(\S+)$/gm)].map((m) => m[1])),
];

describe('published images take OS security updates at build time', () => {
  it('finds the published images it is meant to guard', () => {
    // A guard that matches nothing passes vacuously; fail loudly instead.
    expect(publishedDockerfiles).toEqual(expect.arrayContaining([WEB, WORKER, 'setup/docker/Dockerfile.report-generator']));
  });

  it.each(publishedDockerfiles)('%s runs apt-get upgrade in the stage that ships', (file) => {
    const runs = runInstructions(finalStage(read(file)));
    const upgrade = runs.find((r) => /apt-get update[\s\S]*apt-get upgrade -y/.test(r));
    expect(upgrade, `${file}: the final stage never runs "apt-get update … apt-get upgrade -y"`).toBeDefined();
  });
});

describe('worker image', () => {
  const dockerfile = read(WORKER);

  it('is not built on the Microsoft PowerShell image that is no longer rebuilt', () => {
    expect(dockerfile).not.toMatch(/^FROM\s+mcr\.microsoft\.com\/powershell/m);
  });

  it('installs a pinned PowerShell release and verifies its checksum', () => {
    expect(dockerfile).toMatch(/^ARG POWERSHELL_VERSION=\d+\.\d+\.\d+$/m);
    expect(dockerfile).toMatch(/^ARG POWERSHELL_DEB_SHA256=[0-9a-f]{64}$/m);
    const install = runInstructions(dockerfile).find((r) => /powershell\.deb/.test(r));
    expect(install, 'no RUN downloads the PowerShell package').toBeDefined();
    // The download is the one named by the ARG, and the check runs before the install.
    expect(install).toMatch(/releases\/download\/v\$\{POWERSHELL_VERSION\}\/powershell_\$\{POWERSHELL_VERSION\}-1\.deb_amd64\.deb/);
    const check = install.indexOf('${POWERSHELL_DEB_SHA256}  /tmp/powershell.deb" | sha256sum -c -');
    const apt = install.indexOf('apt-get install -y --no-install-recommends /tmp/powershell.deb');
    expect(check, 'the checksum is never verified').toBeGreaterThan(-1);
    expect(apt, 'the package is never installed').toBeGreaterThan(-1);
    expect(check).toBeLessThan(apt);
  });

  it('keeps the en-US culture the crawlers ran under', () => {
    // A plain Ubuntu base defaults to the POSIX locale; .NET would then format
    // dates and numbers with the invariant culture instead of en-US.
    expect(dockerfile).toMatch(/LC_ALL=en_US\.UTF-8/);
    expect(dockerfile).toMatch(/locale-gen/);
  });
});

describe('web image', () => {
  const stage = finalStage(read(WEB));
  const runs = runInstructions(stage);

  it('removes the package managers after installing the production dependencies', () => {
    const at = runs.findIndex((r) => /rm -rf[^;]*\/usr\/local\/lib\/node_modules\/npm\b/.test(r));
    expect(at, 'npm is never removed from the runtime stage').toBeGreaterThan(-1);
    const removal = runs[at];
    for (const path of ['/usr/local/bin/npm', '/usr/local/bin/npx', '/usr/local/lib/node_modules/corepack']) {
      expect(removal, `${path} is left in the runtime image`).toContain(path);
    }
    // npm ci must have run first (in the same RUN, before the rm) …
    expect(removal.indexOf('npm ci --omit=dev')).toBeGreaterThan(-1);
    expect(removal.indexOf('npm ci --omit=dev')).toBeLessThan(removal.indexOf('rm -rf'));
    // … and nothing after the removal may need npm again.
    for (const later of runs.slice(at + 1)) {
      expect(later, 'a RUN after the removal still calls npm/npx').not.toMatch(/\b(npm|npx|corepack)\s/);
    }
    expect(stage).toMatch(/^CMD \["node", /m);
  });
});
