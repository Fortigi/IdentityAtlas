// Hard-rule guard: every image we publish must be stamped with the SAME version.
//
// `computeSkew` (componentVersions.js) flags web ≠ worker as a version mismatch,
// and that detection is correct — it must keep firing on real skew. The bug it
// surfaced was upstream of it: the release pipeline computed the version once and
// delivered it to only one of the two images, so a *stable* deploy showed the
// worker on a main dev build (Major.Minor.yyyyMMdd.HHmm) while web and database
// showed the release. The mismatch pill was telling the truth about a difference
// that the build itself had manufactured.
//
// Nothing at runtime can catch that: by the time the worker reports a version,
// the wrong one is already baked into the published image. So the invariant is
// enforced statically, over the build definitions themselves — the same shape as
// ingest/assignmentTypes.guard.test.js.
//
// The image list is DERIVED from the workflow (every build step's `file:`), not
// hand-listed, so adding a third image puts it under the guard automatically
// instead of quietly escaping it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (p) => readFileSync(join(repoRoot, p), 'utf8');

const PUBLISH_WORKFLOW = '.github/workflows/docker-publish.yml';
const COMPOSE = 'docker-compose.yml';

// Split a YAML block-sequence of build steps into one chunk per `- name:` item,
// so a `build-args:` belonging to a *neighbouring* step can't satisfy this one.
function buildSteps(yaml) {
  const chunks = yaml.split(/\n(?=      - name: )/);
  return chunks
    .filter((c) => /^\s*uses: docker\/build-push-action/m.test(c))
    .map((c) => ({
      name: (c.match(/- name: (.+)/) || [, '(unnamed)'])[1].trim(),
      dockerfile: (c.match(/^\s*file: \.\/(.+)$/m) || [, null])[1],
      text: c,
    }));
}

describe('published images are stamped with one release version', () => {
  const workflow = read(PUBLISH_WORKFLOW);
  const steps = buildSteps(workflow);

  it('finds the image build steps it is meant to guard', () => {
    // Guards that silently match nothing are the failure mode this repo has been
    // bitten by: if the workflow is restructured, fail loudly rather than pass
    // vacuously over an empty list.
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps.map((s) => s.dockerfile)).toEqual(
      expect.arrayContaining(['app/api/Dockerfile', 'setup/docker/Dockerfile.powershell']),
    );
  });

  it.each(steps)('$name passes MODULE_VERSION from the resolved release version', (step) => {
    const arg = step.text.match(/build-args: MODULE_VERSION=\$\{\{ ([^}]+) \}\}/);
    expect(arg, `"${step.name}" has no MODULE_VERSION build-arg`).not.toBeNull();
    // Not merely *a* version — the one `Extract version` resolved for this run.
    // A step stamping some other expression would reintroduce the skew.
    expect(arg[1].trim()).toBe('steps.version.outputs.version');
  });

  it.each(steps)('$dockerfile declares the ARG/ENV that receives it', (step) => {
    const dockerfile = read(step.dockerfile);
    // An ARG with no matching ENV builds fine and bakes nothing — the exact
    // silent-failure shape of the original bug — so assert both halves.
    expect(dockerfile, `${step.dockerfile} is missing ARG MODULE_VERSION`).toMatch(
      /^ARG MODULE_VERSION=/m,
    );
    expect(dockerfile, `${step.dockerfile} is missing ENV MODULE_VERSION`).toMatch(
      /^ENV MODULE_VERSION=\$MODULE_VERSION\s*$/m,
    );
  });

  it('pushes the tested artifacts rather than rebuilding them untagged', () => {
    // The stamp only reaches users if the image that was built with the build-arg
    // is the image that gets pushed. A rebuild at push time would drop it.
    for (const image of ['identity-atlas-web', 'identity-atlas-worker']) {
      expect(workflow).toMatch(new RegExp(`docker tag ${image}:qa`));
    }
  });

  it('local compose builds stamp both services the same way', () => {
    const compose = read(COMPOSE);
    // Each `build:` block in the dev compose must carry the arg too, so a locally
    // built stack doesn't show a phantom mismatch on Admin → Updates.
    const services = compose.split(/\n(?=  \w[\w-]*:\n)/).filter((s) => /^\s{4}build:/m.test(s));
    expect(services.length).toBeGreaterThanOrEqual(2);
    for (const svc of services) {
      const name = (svc.match(/^ {2}(\S+):/m) || [, '(unknown)'])[1];
      expect(svc, `compose service "${name}" builds without MODULE_VERSION`).toMatch(
        /args:\s*\n\s*MODULE_VERSION:/,
      );
    }
  });
});
