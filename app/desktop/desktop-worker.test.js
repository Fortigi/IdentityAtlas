// Unit tests for the desktop job worker's process hand-over (SEC-2026-09 L-06).
// Run by the API Vitest suite (app/api/vitest.config.js includes this folder).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildDispatch, dispatchJob } = require('./desktop-worker.cjs');

const SECRET = 'CFG-SENTINEL-71';
const KEY = 'fgc_KEY-SENTINEL-72';
const job = { id: 42, jobType: 'entra-id', config: { tenantId: 't-1', clientSecret: SECRET, nested: { password: 'NESTED-73' } } };

describe('buildDispatch', () => {
  it('keeps the config and the API key off the command line', () => {
    const plan = buildDispatch(KEY, job, { PATH: '/bin' });
    const commandLine = plan.args.join(' ');
    expect(commandLine).not.toContain(SECRET);
    expect(commandLine).not.toContain('NESTED-73');
    expect(commandLine).not.toContain(KEY);
    expect(plan.args).not.toContain('-Config');
    expect(plan.args).not.toContain('-ApiKey');
    expect(plan.args.slice(-5)).toEqual(['-JobId', '42', '-JobType', 'entra-id', '-ConfigFromStdin']);
  });

  it('hands the whole config over stdin and the key through IA_JOB_API_KEY', () => {
    const plan = buildDispatch(KEY, job, { PATH: '/bin' });
    expect(JSON.parse(plan.stdin)).toEqual(job.config);
    expect(plan.env.IA_JOB_API_KEY).toBe(KEY);
    expect(plan.env.PATH).toBe('/bin');
  });

  it("does not pass the launcher's own WORKER_API_KEY on to the crawler", () => {
    const plan = buildDispatch(KEY, job, { WORKER_API_KEY: 'launcher-copy' });
    expect(Object.prototype.hasOwnProperty.call(plan.env, 'WORKER_API_KEY')).toBe(false);
  });

  it('resolves the dispatcher under IA_APP_ROOT and sends {} when the job has no config', () => {
    const plan = buildDispatch(KEY, { id: 7, jobType: 'csv' }, { IA_APP_ROOT: '/opt/ia' });
    const file = plan.args[plan.args.indexOf('-File') + 1];
    expect(file.replace(/\\/g, '/')).toBe('/opt/ia/setup/docker/Invoke-CrawlerJob.ps1');
    expect(plan.env.IA_APP_ROOT).toBe('/opt/ia');
    expect(plan.stdin).toBe('{}');
  });
});

describe('dispatchJob', () => {
  let child;
  let spawnImpl;
  let fetchMock;

  beforeEach(() => {
    child = new EventEmitter();
    child.stdin = { on: vi.fn(), end: vi.fn() };
    spawnImpl = vi.fn(() => child);
    fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('pipes stdin, writes the config to it once, and passes the key only in the environment', () => {
    dispatchJob(KEY, job, spawnImpl);
    const [command, args, options] = spawnImpl.mock.calls[0];
    expect(command).toBe('pwsh.exe');
    expect(args.join(' ')).not.toContain(KEY);
    expect(options.stdio).toEqual(['pipe', 'inherit', 'inherit']);
    expect(options.env.IA_JOB_API_KEY).toBe(KEY);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(JSON.parse(child.stdin.end.mock.calls[0][0])).toEqual(job.config);
  });

  it('marks the job complete on exit code 0', async () => {
    dispatchJob(KEY, job, spawnImpl);
    child.emit('close', 0);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/crawlers\/jobs\/42\/complete$/);
  });

  it('marks the job failed with the exit code otherwise', async () => {
    dispatchJob(KEY, job, spawnImpl);
    child.emit('close', 1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/crawlers\/jobs\/42\/fail$/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).errorMessage).toBe('pwsh.exe exited with code 1');
  });

  it('explains a missing PowerShell install when pwsh.exe cannot be started', async () => {
    dispatchJob(KEY, job, spawnImpl);
    child.emit('error', Object.assign(new Error('spawn pwsh.exe ENOENT'), { code: 'ENOENT' }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).errorMessage).toMatch(/PowerShell \(pwsh\.exe\) not found/);
  });
});
