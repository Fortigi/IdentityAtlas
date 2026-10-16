// Unit tests for the portable launcher's report-model supervisor
// (node-launcher/llmSupervisor.mjs). Run by the API Vitest suite
// (app/api/vitest.config.js includes this folder). llama-server itself is faked:
// a child that never runs, and an upstream HTTP server standing in for it.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  llmConfigFromEnv, llmFeatureEnv, serverArgs, authorised, modelList, Model, makeHandler,
  freePort, startLlmSupervisor, defaultLogStream, UPSTREAM_ROUTES, PID_FILE, LOG_FILE,
} from './node-launcher/llmSupervisor.mjs';

const ENV = { IA_LLM_SERVER: 'C:\\llm\\llama-server.exe', IA_LLM_MODEL: 'C:\\llm\\m.gguf', IA_LLM_ALIAS: 'qwen3:4b' };
const CFG = { exe: 'llama-server.exe', model: 'm.gguf', alias: 'qwen3:4b', slotsDir: join(tmpdir(), 'ia-llm-test-slots'), dataDir: 'D', idleSeconds: 900, readyTimeoutMs: 1000 };

function fakeChild({ pid = 4242 } = {}) {
  const c = new EventEmitter();
  Object.assign(c, { pid, exitCode: null, signalCode: null, stdout: null, stderr: null });
  c.kill = vi.fn(() => { c.signalCode = 'SIGTERM'; return true; });
  return c;
}

function newModel(over = {}) {
  const child = over.child ?? fakeChild();
  const spawn = vi.fn(() => child);
  const writePid = vi.fn();
  let t = 1_000;
  const model = new Model({
    cfg: CFG, apiKey: 'k', port: 1, spawn, healthy: async () => true, now: () => t, pollMs: 1,
    writePid, logStream: () => null, ...over.opts,
  });
  return { model, child, spawn, writePid, advance: s => { t += s * 1000; } };
}

const servers = [];
async function listen(handler) {
  const s = createServer(handler);
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map(s => new Promise(r => s.close(r))));
});

describe('llmConfigFromEnv', () => {
  it('is null unless the launcher passed both the server and the model', () => {
    expect(llmConfigFromEnv({}, 'D')).toBeNull();
    expect(llmConfigFromEnv({ IA_LLM_SERVER: 'x' }, 'D')).toBeNull();
    expect(llmConfigFromEnv({ IA_LLM_MODEL: 'x' }, 'D')).toBeNull();
  });

  it('reads the launcher environment, with the Docker supervisor defaults', () => {
    expect(llmConfigFromEnv(ENV, 'D:\\data')).toEqual({
      exe: ENV.IA_LLM_SERVER, model: ENV.IA_LLM_MODEL, alias: 'qwen3:4b',
      slotsDir: join('D:\\data', 'llm-slots'), dataDir: 'D:\\data', idleSeconds: 900, readyTimeoutMs: 600_000,
    });
  });

  it('honours the idle and ready settings, including 0 = keep loaded', () => {
    const c = llmConfigFromEnv({ ...ENV, REPORT_GENERATOR_IDLE_SECONDS: '0', REPORT_GENERATOR_READY_TIMEOUT: '30' }, 'D');
    expect(c.idleSeconds).toBe(0);
    expect(c.readyTimeoutMs).toBe(30_000);
    expect(llmConfigFromEnv({ ...ENV, REPORT_GENERATOR_IDLE_SECONDS: 'soon' }, 'D').idleSeconds).toBe(900);
    expect(llmConfigFromEnv({ ...ENV, REPORT_GENERATOR_IDLE_SECONDS: '' }, 'D').idleSeconds).toBe(900);
  });

  it('falls back to a generic alias', () => {
    expect(llmConfigFromEnv({ IA_LLM_SERVER: 'a', IA_LLM_MODEL: 'b' }, 'D').alias).toBe('model');
  });
});

describe('llmFeatureEnv', () => {
  it('switches custom reports on unless the environment already decides', () => {
    expect(llmFeatureEnv({})).toEqual({ FEATURE_CUSTOM_REPORTS: 'true' });
    expect(llmFeatureEnv({ FEATURE_CUSTOM_REPORTS: 'false' })).toEqual({});
  });
});

describe('serverArgs', () => {
  it('binds llama-server to loopback on the given port, with the Docker flags', () => {
    expect(serverArgs(CFG, 51234)).toEqual(['-m', 'm.gguf', '--alias', 'qwen3:4b', '-c', '8192', '-np', '1',
      '--slot-save-path', CFG.slotsDir, '--no-slots', '--host', '127.0.0.1', '--port', '51234']);
  });
});

describe('authorised', () => {
  it.each([
    [undefined, '', true],
    ['anything', '', true],
    ['Bearer s3cret', 's3cret', true],
    ['Bearer s3creT', 's3cret', false],
    ['Bearer s3cret ', 's3cret', false],
    ['s3cret', 's3cret', false],
    [undefined, 's3cret', false],
  ])('%s with key %j -> %s', (header, key, want) => expect(authorised(header, key)).toBe(want));
});

describe('modelList', () => {
  it('reports loaded only when ready', () => {
    expect(modelList('a', 'ready').data[0]).toMatchObject({ id: 'a', loaded: true, state: 'ready' });
    expect(modelList('a', 'starting').data[0]).toMatchObject({ loaded: false, state: 'starting' });
  });
});

describe('Model', () => {
  it('starts llama-server once for requests that arrive together, and records its pid', async () => {
    let healthyCalls = 0;
    const { model, spawn, writePid } = newModel({ opts: { healthy: async () => ++healthyCalls > 3 } });
    await Promise.all([model.acquire(), model.acquire(), model.acquire()]);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [exe, args, opts] = spawn.mock.calls[0];
    expect(exe).toBe('llama-server.exe');
    expect(args.slice(-4)).toEqual(['--host', '127.0.0.1', '--port', '1']);
    expect(opts).toMatchObject({ windowsHide: true, env: expect.objectContaining({ LLAMA_API_KEY: 'k' }) });
    expect(writePid).toHaveBeenCalledWith('D', 4242);
    expect(model.inFlight).toBe(3);
    expect(model.currentState()).toBe('ready');
  });

  it('does not start again while the child runs', async () => {
    const { model, spawn } = newModel();
    await model.acquire(); model.release();
    await model.acquire(); model.release();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(model.inFlight).toBe(0);
  });

  it('starts again after the child died, and calls a dead child unloaded', async () => {
    const first = fakeChild({ pid: 1 }); const second = fakeChild({ pid: 2 });
    const { model, spawn } = newModel();
    spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    await model.acquire(); model.release();
    first.exitCode = 1;
    expect(model.currentState()).toBe('unloaded');
    await model.acquire();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(model.proc).toBe(second);
  });

  it('fails, unloaded and not counted, when the child exits while starting', async () => {
    const child = fakeChild();
    const { model, writePid } = newModel({ child, opts: { healthy: async () => { child.exitCode = 3; return false; } } });
    await expect(model.acquire()).rejects.toThrow(/exited while starting \(code 3\)/);
    expect(model.inFlight).toBe(0);
    expect(model.currentState()).toBe('unloaded');
    expect(writePid).toHaveBeenLastCalledWith('D', null);
  });

  it('fails with the reason when the executable cannot be started (blocked or missing)', async () => {
    const child = fakeChild();
    const { model } = newModel({ child, opts: { healthy: async () => { child.emit('error', new Error('spawn EACCES')); return false; } } });
    await expect(model.acquire()).rejects.toThrow(/could not be started: spawn EACCES/);
  });

  it('gives up and stops the child when it never becomes healthy', async () => {
    const child = fakeChild();
    let t = 0;
    const { model } = newModel({ child, opts: { healthy: async () => { t += 600; return false; }, now: () => t } });
    await expect(model.acquire()).rejects.toThrow(/did not become ready in time/);
    expect(child.kill).toHaveBeenCalled();
    expect(model.currentState()).toBe('unloaded');
  });

  it('unloads only when idle long enough with nothing in flight', async () => {
    const { model, child, advance, writePid } = newModel();
    expect(model.stopIfIdle(900)).toBe(false);          // never started
    await model.acquire();
    advance(1000);
    expect(model.stopIfIdle(900)).toBe(false);          // a request is in flight
    model.release();
    advance(899);
    expect(model.stopIfIdle(900)).toBe(false);          // not idle long enough
    expect(model.stopIfIdle(0)).toBe(false);            // 0 = keep loaded
    advance(1);
    expect(model.stopIfIdle(900)).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(writePid).toHaveBeenLastCalledWith('D', null);
    expect(model.currentState()).toBe('unloaded');
  });

  it('writes and removes the pid file in the data directory by default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ia-llm-'));
    try {
      const model = new Model({ cfg: { ...CFG, dataDir: dir, slotsDir: join(dir, 'slots') }, apiKey: '', port: 1,
        spawn: () => fakeChild({ pid: 777 }), healthy: async () => true, pollMs: 1, logStream: () => null });
      await model.acquire();
      expect(readFileSync(join(dir, PID_FILE), 'utf8')).toBe('777');
      expect(existsSync(join(dir, 'slots'))).toBe(true);
      model.release();
      model.stop();
      expect(existsSync(join(dir, PID_FILE))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('defaultLogStream', () => {
  it('captures the child output in the data directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ia-llm-'));
    try {
      const s = defaultLogStream(dir);
      await new Promise(r => s.end('loaded model\n', r));
      expect(readFileSync(join(dir, LOG_FILE), 'utf8')).toBe('loaded model\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('swallows a log file that cannot be opened instead of ending node.exe', async () => {
    const s = defaultLogStream(join(tmpdir(), 'ia-llm-does-not-exist', 'nested'));
    const failed = await new Promise(r => { s.once('error', () => r(true)); s.once('open', () => r(false)); });
    expect(failed).toBe(true);
    expect(s.listenerCount('error')).toBe(1);   // the module's own handler, still attached
  });
});

describe('makeHandler', () => {
  function fakeModel(over = {}) {
    return { port: 1, currentState: () => 'unloaded', acquire: vi.fn(async () => {}), release: vi.fn(), ...over };
  }

  it('answers /health without a key and without waking the model', async () => {
    const model = fakeModel();
    const url = await listen(makeHandler(model, 'key', 'a'));
    const r = await fetch(`${url}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok', model: 'unloaded' });
    expect(model.acquire).not.toHaveBeenCalled();
  });

  it('refuses everything else without the key', async () => {
    const url = await listen(makeHandler(fakeModel(), 'key', 'a'));
    for (const p of ['/v1/models', '/props']) expect((await fetch(url + p)).status).toBe(401);
    expect((await fetch(`${url}/v1/models`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
  });

  it('lists the model from its state, on both paths', async () => {
    const url = await listen(makeHandler(fakeModel({ currentState: () => 'ready' }), 'key', 'qwen'));
    for (const p of ['/v1/models', '/models']) {
      const r = await fetch(url + p, { headers: { Authorization: 'Bearer key' } });
      expect((await r.json()).data[0]).toMatchObject({ id: 'qwen', loaded: true });
    }
  });

  it.each([
    ['GET', '/v1/chat/completions'],
    ['POST', '/completion'],
    ['POST', '/slots/0?action=erase'],
    ['POST', '/slots/1?action=save'],
    ['GET', '/slots'],
  ])('does not pass %s %s through', async (method, path) => {
    const model = fakeModel();
    const url = await listen(makeHandler(model, '', 'a'));
    expect((await fetch(url + path, { method, body: method === 'POST' ? '{}' : undefined })).status).toBe(404);
    expect(model.acquire).not.toHaveBeenCalled();
  });

  it('refuses a body over 1 MB before waking the model', async () => {
    const model = fakeModel();
    const url = await listen(makeHandler(model, '', 'a'));
    const r = await fetch(`${url}/v1/chat/completions`, { method: 'POST', body: 'x'.repeat(1_000_001) });
    expect(r.status).toBe(413);
    expect(model.acquire).not.toHaveBeenCalled();
  });

  it('says 503 with the reason when the model cannot start, and counts nothing', async () => {
    const model = fakeModel({ acquire: vi.fn(async () => { throw new Error('the model server exited while starting'); }) });
    const url = await listen(makeHandler(model, '', 'a'));
    const r = await fetch(`${url}/props`);
    expect(r.status).toBe(503);
    expect((await r.json()).error.message).toMatch(/exited while starting/);
    expect(model.release).not.toHaveBeenCalled();
  });

  it('says 502 and releases when the model server does not answer', async () => {
    const model = fakeModel();
    const url = await listen(makeHandler(model, '', 'a', { forwardFn: async () => { throw new Error('ECONNRESET'); } }));
    expect((await fetch(`${url}/props`)).status).toBe(502);
    expect(model.release).toHaveBeenCalledTimes(1);
  });

  it('passes an allowed request through unchanged to the fixed upstream path', async () => {
    const seen = [];
    const upstream = await listen((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
        res.setHeader('x-from', 'llama');
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('{"choices":[]}');
      });
    });
    const model = fakeModel({ port: Number(new URL(upstream).port) });
    const url = await listen(makeHandler(model, 'key', 'a'));
    const r = await fetch(`${url}/slots/0?action=save`, {
      method: 'POST', headers: { Authorization: 'Bearer key', 'content-type': 'application/json' }, body: '{"filename":"p.bin"}',
    });
    expect(r.status).toBe(201);
    expect(r.headers.get('x-from')).toBe('llama');
    expect(await r.text()).toBe('{"choices":[]}');
    expect(seen).toEqual([{ method: 'POST', url: '/slots/0?action=save', auth: 'Bearer key', body: '{"filename":"p.bin"}' }]);
    expect(model.acquire).toHaveBeenCalledTimes(1);
    expect(model.release).toHaveBeenCalledTimes(1);
  });

  it('allows exactly the endpoints the API client uses', () => {
    expect([...UPSTREAM_ROUTES.keys()].sort()).toEqual([
      'GET /props', 'POST /slots/0?action=restore', 'POST /slots/0?action=save', 'POST /v1/chat/completions',
    ]);
  });
});

describe('freePort', () => {
  it('returns a loopback port that can be listened on', async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    const s = createServer();
    await new Promise(r => s.listen(port, '127.0.0.1', r));
    await new Promise(r => s.close(r));
  });
});

describe('startLlmSupervisor', () => {
  it('listens on loopback with a fresh key, and stops the child when node.exe exits', async () => {
    const proc = new EventEmitter();
    const child = fakeChild();
    const log = vi.fn();
    const sup = await startLlmSupervisor({ ...CFG, idleSeconds: 60 }, {
      proc, log, modelOptions: { spawn: () => child, healthy: async () => true, writePid: () => {}, logStream: () => null },
    });
    const { NL_REPORTS_LLM_URL: url, NL_REPORTS_LLM_API_KEY: key, NL_REPORTS_LLM_BACKEND: backend } = sup.env;
    expect(backend).toBe('llamacpp');
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(key).toMatch(/^[\w-]{32}$/);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/unloaded after 60s unused/));
    expect((await fetch(`${url}/v1/models`)).status).toBe(401);
    expect((await fetch(`${url}/v1/models`, { headers: { Authorization: `Bearer ${key}` } })).status).toBe(200);

    await sup.model.acquire(); sup.model.release();
    proc.emit('exit', 0);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(sup.model.currentState()).toBe('unloaded');
  });

  it('a second supervisor gets a different key', async () => {
    const opts = { proc: new EventEmitter(), log: () => {}, modelOptions: { spawn: fakeChild, writePid: () => {}, logStream: () => null } };
    const a = await startLlmSupervisor(CFG, opts);
    const b = await startLlmSupervisor({ ...CFG, idleSeconds: 0 }, opts);
    expect(a.env.NL_REPORTS_LLM_API_KEY).not.toBe(b.env.NL_REPORTS_LLM_API_KEY);
    a.stop(); b.stop();
  });

  it('unloads an idle model on its timer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let t = 0;
    const child = fakeChild();
    const log = vi.fn();
    const sup = await startLlmSupervisor({ ...CFG, idleSeconds: 60 }, {
      proc: new EventEmitter(), log,
      modelOptions: { spawn: () => child, healthy: async () => true, now: () => t, writePid: () => {}, logStream: () => null },
    });
    await sup.model.acquire(); sup.model.release();
    t = 59_000; vi.advanceTimersByTime(15_000);
    expect(child.kill).not.toHaveBeenCalled();
    t = 60_000; vi.advanceTimersByTime(15_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith('Report model unloaded after 60s unused.');
    sup.stop();
  });
});
