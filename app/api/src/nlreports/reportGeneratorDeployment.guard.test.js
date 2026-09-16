// Hard guard: how the report-generator container is STARTED.
//
// Two settings of llama-server are load-bearing and both fail silently when they
// are spelled wrong — the server starts, answers, and simply does less:
//
//   1. `--api-key` reads ONLY the env var `LLAMA_API_KEY`. Written as
//      `LLAMA_ARG_API_KEY` (the prefix every *other* option uses) it is ignored and
//      the server serves every request unauthenticated. On Azure that container has
//      public ingress, so the one control on it would be gone with nothing to see.
//   2. `--slot-save-path` has NO env var at all. Passed as
//      `LLAMA_ARG_SLOT_SAVE_PATH` the prompt cache is simply off: the server answers
//      501 to a save, every cold start re-reads the whole prompt (minutes), and the
//      only symptom is that it feels slow.
//
// Both were real: the second shipped in the first build of this image, the first was
// caught in review. This test scans the deployment files rather than the app code,
// because that is where the mistake lives.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(import.meta.dirname, '..', '..', '..', '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

const DOCKERFILE = 'setup/docker/Dockerfile.report-generator';
const BICEP = 'azure/modules/aca-app-report-generator.bicep';
const ARM = 'azure/main.json';

// Both files explain the trap in a comment, so the scan has to look at what is
// actually passed to the container, not at the prose warning about it.
const withoutComments = (text) =>
  text
    .split('\n')
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join('\n');

describe('report-generator container start-up', () => {
  it('passes --slot-save-path as a flag, since it has no environment variable', () => {
    const dockerfile = read(DOCKERFILE);
    expect(dockerfile).toMatch(/"--slot-save-path", "\/slots"/);
    for (const file of [DOCKERFILE, BICEP, ARM, 'docker-compose.prod.yml', 'docker-compose.nl-reports.yml']) {
      expect(withoutComments(read(file)), `${file}: LLAMA_ARG_SLOT_SAVE_PATH is ignored by llama-server`)
        .not.toMatch(/LLAMA_ARG_SLOT_SAVE_PATH/);
    }
  });

  it('keeps the slots monitoring endpoint off, so no caller can read the current prompt', () => {
    expect(read(DOCKERFILE)).toMatch(/"--no-slots"/);
  });

  it('never spells the api key LLAMA_ARG_API_KEY, in any deployment file', () => {
    for (const file of [DOCKERFILE, BICEP, ARM, 'docker-compose.prod.yml', 'docker-compose.nl-reports.yml']) {
      expect(withoutComments(read(file)), `${file} must not use LLAMA_ARG_API_KEY — llama-server ignores it`)
        .not.toMatch(/LLAMA_ARG_API_KEY/);
    }
  });

  it('gives the publicly reachable Azure app an api key under the name llama-server reads', () => {
    for (const file of [BICEP, ARM]) {
      const text = read(file);
      // Public ingress, so the key is the control: it must be set, and from a secret.
      expect(text, `${file} must set LLAMA_API_KEY`).toMatch(/LLAMA_API_KEY/);
      expect(text).toMatch(/secretRef/);
    }
  });

  it('verifies the model file it bakes in, and refuses to build without a checksum', () => {
    const dockerfile = read(DOCKERFILE);
    expect(dockerfile).toMatch(/^ARG MODEL_SHA256=[0-9a-f]{64}$/m);
    expect(dockerfile).toMatch(/sha256sum -c -/);
    expect(dockerfile, 'an empty checksum must fail the build, not warn').toMatch(/MODEL_SHA256:-.*exit 1/s);
  });

  it('runs as a non-root user that can write the prompt cache', () => {
    const dockerfile = read(DOCKERFILE);
    expect(dockerfile).toMatch(/^USER 1000$/m);
    expect(dockerfile, '/slots is root-owned from the build unless it is handed over').toMatch(/chown -R 1000:1000 \/slots/);
  });

  it('keeps the model server off every network but the web container on Docker', () => {
    const compose = read('docker-compose.prod.yml');
    const service = compose.slice(compose.indexOf('  report-generator:'));
    expect(service, 'no published port — the web container reaches it by name').not.toMatch(/^\s+ports:/m);
    expect(compose).toMatch(/report-generator:\n {4}internal: true/);
  });
});
