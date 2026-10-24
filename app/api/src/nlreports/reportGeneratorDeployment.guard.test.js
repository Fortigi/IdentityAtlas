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

  it('runs the supervisor as the main process, and never exposes llama-server itself', () => {
    const dockerfile = withoutComments(read(DOCKERFILE));
    // The supervisor loads the model on demand and checks the API key before it
    // starts anything; llama-server behind it must only be reachable from inside.
    expect(dockerfile).toMatch(/^COPY setup\/docker\/report-generator\/supervisor\.py \/app\/supervisor\.py$/m);
    expect(dockerfile).toMatch(/^ENTRYPOINT \["python3", "\/app\/supervisor\.py"\]$/m);
    expect(dockerfile, 'llama-server must not be given a host/port: the supervisor binds it to loopback')
      .not.toMatch(/"--host"|"--port"/);
    expect(read('setup/docker/report-generator/supervisor.py')).toMatch(/^CHILD_HOST = "127\.0\.0\.1"$/m);
  });

  it('runs the supervisor tests in CI, since they are Python and outside both test suites', () => {
    expect(read('.github/workflows/pr.yml')).toMatch(/python3 -m pytest setup\/docker\/report-generator\/test_supervisor\.py/);
  });

  it('lets a deployment choose how long an unused model stays loaded', () => {
    expect(read(DOCKERFILE)).toMatch(/^ENV REPORT_GENERATOR_IDLE_SECONDS=\d+$/m);
    for (const file of ['docker-compose.prod.yml', 'docker-compose.nl-reports.yml']) {
      expect(read(file), file).toMatch(/REPORT_GENERATOR_IDLE_SECONDS: "\$\{REPORT_GENERATOR_IDLE_SECONDS:-\d+\}"/);
    }
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

  it("ships the model's licence and attribution from the repo, not from a build-time fetch", () => {
    const dockerfile = read(DOCKERFILE);
    // Apache-2.0 requires the licence to accompany the work. This used to be fetched
    // at build time from a URL that 404'd, leaving a placeholder note in the image.
    expect(dockerfile).toMatch(/^COPY setup\/docker\/report-generator\/MODEL-LICENSE\.txt .*MODEL-NOTICE\.txt .*LLAMA-CPP-LICENSE\.txt \/models\/$/m);
    // llama.cpp is MIT: its notice must travel with its binaries, and the upstream
    // image does not carry it.
    expect(read('setup/docker/report-generator/LLAMA-CPP-LICENSE.txt')).toMatch(/MIT License[\s\S]*The ggml authors/);
    expect(dockerfile, 'a licence must not depend on the network at build time').not.toMatch(/MODEL_LICENSE_URL/);
    expect(read('setup/docker/report-generator/MODEL-LICENSE.txt')).toMatch(/Apache License\s+Version 2\.0/);
    // The notice is what tells a reader which model this is and where it came from.
    const notice = read('setup/docker/report-generator/MODEL-NOTICE.txt');
    expect(notice).toMatch(/Qwen3-4B-Instruct-2507/);
    expect(notice).toMatch(/Apache License 2\.0/);
  });

  it('comes back after the host restarts, in production and development alike', () => {
    // Found on sk9: after a VM restart web and postgres came back but the generator
    // did not (no restart policy in the development overlay), and the builder said
    // the model server was unreachable.
    for (const file of ['docker-compose.prod.yml', 'docker-compose.nl-reports.yml']) {
      const text = read(file);
      const service = text.slice(text.indexOf('  report-generator:\n'), text.indexOf('\nnetworks:'));
      expect(service, `${file}: report-generator needs a restart policy`).toMatch(/^\s+restart: unless-stopped$/m);
    }
  });

  it('runs as a non-root user that can write the prompt cache', () => {
    const dockerfile = read(DOCKERFILE);
    expect(dockerfile).toMatch(/^USER 1000$/m);
    expect(dockerfile, '/slots is root-owned from the build unless it is handed over').toMatch(/chown -R 1000:1000 \/slots/);
  });

  it('runs the Docker service with no capabilities and no privilege escalation, in production and development alike', () => {
    // Verified against the pinned image: health, completions and prompt-cache save
    // all work with every capability dropped.
    for (const file of ['docker-compose.prod.yml', 'docker-compose.nl-reports.yml']) {
      const text = read(file);
      const service = text.slice(text.indexOf('  report-generator:\n'), text.indexOf('\nnetworks:'));
      expect(service, `${file}: report-generator must drop all capabilities`).toMatch(/cap_drop: \[ALL\]/);
      expect(service, `${file}: report-generator must set no-new-privileges`).toMatch(/no-new-privileges:true/);
      expect(service, `${file}: report-generator must cap its process count`).toMatch(/pids_limit: \d+/);
    }
  });

  it('keeps the model server off every network but the web container on Docker', () => {
    const compose = read('docker-compose.prod.yml');
    const service = compose.slice(compose.indexOf('  report-generator:'));
    expect(service, 'no published port — the web container reaches it by name').not.toMatch(/^\s+ports:/m);
    expect(compose).toMatch(/report-generator:\n {4}internal: true/);
  });
});
