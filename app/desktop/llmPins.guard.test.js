// Guard: the portable report model is the Docker report model.
//
// The portable launcher downloads its model itself (Launcher.Llm.ps1) and starts
// llama-server itself (llmSupervisor.mjs), so nothing would notice if a release
// moved the Docker image to a new model, checksum or set of server flags and
// left the laptop on the old one: the prompts are tuned and measured against
// exactly one model. This reads both sides and fails when they disagree.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serverArgs } from './node-launcher/llmSupervisor.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const dockerfile = readFileSync(join(ROOT, 'setup', 'docker', 'Dockerfile.report-generator'), 'utf8');
const launcher = readFileSync(join(import.meta.dirname, 'node-launcher', 'Launcher.Llm.ps1'), 'utf8');
const startScript = readFileSync(join(import.meta.dirname, 'node-launcher', 'Start-IdentityAtlas.ps1'), 'utf8');

const dockerArg = name => dockerfile.match(new RegExp(`^ARG ${name}=(\\S+)$`, 'm'))?.[1];
const psVar = name => launcher.match(new RegExp(`^\\$script:${name}\\s*=\\s*'([^']+)'`, 'm'))?.[1];

describe('portable report model pins', () => {
  it('downloads the model the Docker image ships, with the same checksum and alias', () => {
    expect(psVar('LlmModelUrl')).toBe(dockerArg('MODEL_URL'));
    expect(psVar('LlmModelSha256')).toBe(dockerArg('MODEL_SHA256'));
    expect(psVar('LlmModelAlias')).toBe(dockerArg('MODEL_NAME'));
    expect(dockerArg('MODEL_URL').endsWith('/' + psVar('LlmModelFile'))).toBe(true);
  });

  it('pins llama.cpp by build and SHA-256', () => {
    expect(psVar('LlamaCppBuild')).toMatch(/^b\d+$/);
    expect(psVar('LlamaCppSha256')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('names the pinned files in the launcher help, for copying them in by hand', () => {
    expect(startScript).toContain(`llama-${psVar('LlamaCppBuild')}-bin-win-cpu-x64.zip`);
    expect(startScript).toContain(psVar('LlmModelFile'));
  });

  it('starts llama-server with the flags the Docker image uses', () => {
    const cmd = JSON.parse(dockerfile.match(/^CMD (\[[\s\S]*?\])$/m)[1].replace(/\\\n/g, ''));
    const docker = cmd.slice(1);                              // drop /app/llama-server
    const portable = serverArgs({ model: '/models/model.gguf', alias: dockerArg('MODEL_NAME'), slotsDir: '/slots' }, 1)
      .slice(0, -4);                                          // drop --host/--port: the supervisors add those
    expect(portable).toEqual(docker);
  });
});
