// Hard-rule guard: every GitHub release ships BOTH portable Windows ZIPs.
//
//   IdentityAtlas-portable.zip           PGlite; node.exe is its only executable
//                                        and is code-signed. The default.
//   IdentityAtlas-portable-postgres.zip  Embedded PostgreSQL (--with-postgres)
//                                        for data sets PGlite cannot hold.
//
// `Start-IdentityAtlas.ps1 -Database Postgres` fails with "no postgres binaries
// found" on the default ZIP, so a release that ships only that one leaves large
// customers with nothing to run. Nothing at runtime can notice that — the cut-*
// workflows are workflow_dispatch and create real tags — so the invariant is
// checked statically, over the workflow and script text, in the style of
// app/api/src/updates/imageVersionStamp.guard.test.js.
//
// The build ordering is guarded too: build-node-launcher.mjs always writes
// dist-node-launcher/IdentityAtlas-portable.zip and deletes it first, so the
// second build silently destroys the first's zip unless it was moved away.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(repoRoot, p), 'utf8').replace(/\r\n/g, '\n');

const WORKFLOWS = ['cut-release.yml', 'cut-beta.yml', 'cut-hotfix.yml'];
const SCRIPT = '.github/scripts/build_portable_zips.sh';
const DOWNLOADS = 'tools/release-notes/portable-downloads.md';
const DEFAULT_ASSET = 'IdentityAtlas-portable.zip';
const POSTGRES_ASSET = 'IdentityAtlas-portable-postgres.zip';

// One chunk per step, so text in a neighbouring step cannot satisfy this one.
function steps(yaml) {
  return yaml.split(/\n(?=      - (?:name|uses): )/).slice(1);
}

// The positional .zip arguments of the `gh release create` command.
function uploadedZips(step) {
  const cmd = step.match(/gh release create[\s\S]*?(?=\n\s*--|\n\n|$)/);
  if (!cmd) return null;
  return cmd[0].split(/\s+\\?\s*/).filter((tok) => tok.endsWith('.zip'));
}

// The paths the build script writes its two zips to, resolved from its own
// variables, relative to the repo root (the script runs inside app/api).
function scriptOutputs(script) {
  const v = (name) => {
    const m = script.match(new RegExp(`^${name}="?([^"\\n]+)"?$`, 'm'));
    return m ? m[1] : null;
  };
  const expand = (s) => s.replace(/\$(\w+)/g, (_, n) => expand(v(n) ?? `<${n} undefined>`));
  return {
    defaultZip: `app/api/${expand(v('DEFAULT_ZIP'))}`,
    postgresZip: `app/api/${expand(v('POSTGRES_ZIP'))}`,
  };
}

describe('the build script produces both portable ZIPs', () => {
  const script = read(SCRIPT);
  const lines = script.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const indexOf = (pred, what) => {
    const i = lines.findIndex(pred);
    expect(i, `${SCRIPT}: no line that ${what}`).toBeGreaterThanOrEqual(0);
    return i;
  };

  it('writes each asset under its published name', () => {
    const out = scriptOutputs(script);
    expect(out.defaultZip).toBe(`app/api/dist-node-launcher/release/${DEFAULT_ASSET}`);
    expect(out.postgresZip).toBe(`app/api/dist-node-launcher/release/${POSTGRES_ASSET}`);
  });

  it('builds the default, moves it away, then builds and moves the PostgreSQL variant', () => {
    const isBuild = (l) => /build:node-launcher|build-node-launcher\.mjs/.test(l);
    const defaultBuild = indexOf((l) => isBuild(l) && !l.includes('--with-postgres'), 'runs the default build');
    const defaultMove = indexOf((l) => /^mv .*"\$DEFAULT_ZIP"$/.test(l), 'moves the default zip to $DEFAULT_ZIP');
    const pgBuild = indexOf((l) => isBuild(l) && l.includes('--with-postgres'), 'runs the --with-postgres build');
    const pgMove = indexOf((l) => /^mv .*"\$POSTGRES_ZIP"$/.test(l), 'moves the PostgreSQL zip to $POSTGRES_ZIP');
    expect(defaultBuild).toBeLessThan(defaultMove);
    // The move must happen BEFORE the second build, or that build deletes the zip.
    expect(defaultMove).toBeLessThan(pgBuild);
    expect(pgBuild).toBeLessThan(pgMove);
  });
});

describe.each(WORKFLOWS)('%s ships both portable ZIPs', (file) => {
  const all = steps(read(`.github/workflows/${file}`));
  const { defaultZip, postgresZip } = scriptOutputs(read(SCRIPT));
  const stepIndex = (re) => all.findIndex((s) => re.test(s));

  it('builds them with the shared script, not an inline single build', () => {
    expect(all.filter((s) => s.includes(`bash ${SCRIPT}`))).toHaveLength(1);
    // A leftover direct build would overwrite or skip the PostgreSQL variant.
    expect(all.some((s) => /npm run build:node-launcher/.test(s))).toBe(false);
  });

  it('attaches exactly the two zips the script produced', () => {
    const release = all.filter((s) => s.includes('gh release create'));
    expect(release).toHaveLength(1);
    expect(uploadedZips(release[0])).toEqual([defaultZip, postgresZip]);
  });

  it('appends the download guide after polishing and before publishing', () => {
    const polish = stepIndex(/uses: anthropics\/claude-code-action/);
    const append = all.findIndex((s) => s.includes(`cat ${DOWNLOADS} >> release-notes.md`));
    const publish = stepIndex(/gh release create/);
    expect(polish).toBeGreaterThanOrEqual(0);
    // After the model step: it is told to drop "tooling" text and could lose this.
    expect(append).toBeGreaterThan(polish);
    expect(append).toBeLessThan(publish);
  });
});

describe('the download guide in the release notes', () => {
  const guide = read(DOWNLOADS);

  it('names both assets and says what sets the PostgreSQL one apart', () => {
    expect(guide).toContain(`\`${DEFAULT_ASSET}\``);
    expect(guide).toContain(`\`${POSTGRES_ASSET}\``);
    expect(guide).toContain('-Database Postgres');
    expect(guide).toContain('VCRUNTIME140.dll');
    expect(guide).toMatch(/not code-signed/);
  });
});
