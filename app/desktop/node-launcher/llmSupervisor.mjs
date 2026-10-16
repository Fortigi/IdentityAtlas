// The report generator's model server, for the portable launcher.
//
// The Docker deployment runs llama-server behind a small Python supervisor
// (setup/docker/report-generator/supervisor.py). A locked-down laptop has no
// Python, so this is the same supervisor in Node, running inside the node.exe
// that already serves the app. It:
//
//   * starts llama-server.exe, on 127.0.0.1 only, when the first request that
//     needs the model arrives, and waits until it reports healthy;
//   * passes the few requests the API makes through unchanged;
//   * answers /health and the model list itself, without waking the model;
//   * stops llama-server once nothing has used it for idleSeconds (default 900),
//     which hands its ~3 GB back to a laptop that is also running everything else.
//
// The API talks to it exactly as it talks to the Docker supervisor
// (app/api/src/nlreports/llamacpp.js), so nothing in the API knows the difference.
//
// llama-server.exe is a separate process, and Windows does not end a child when
// its parent dies. Its pid is written to llm-server.pid in the data directory so
// the launcher and its watchdog can stop one that node.exe left behind
// (Stop-OrphanedLlamaServer in Launcher.Llm.ps1).

import { createServer, request as httpRequest } from 'node:http';
import { spawn as nodeSpawn } from 'node:child_process';
import { createWriteStream, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1_000_000;
// Longer than the API waits (15 minutes), so the API gives up first; but finite,
// so a hung model server cannot stay "in flight" and block unloading forever.
const FORWARD_TIMEOUT_MS = 1_800_000;
const REAP_INTERVAL_MS = 15_000;
export const PID_FILE = 'llm-server.pid';
export const LOG_FILE = 'llm-server.log';

// The model-server endpoints the API uses, and the only ones passed through.
// Keyed on method and the path exactly as requested; the value is what is sent
// upstream, so the forwarded path never comes from the request.
export const UPSTREAM_ROUTES = new Map([
  ['GET /props', '/props'],
  ['POST /v1/chat/completions', '/v1/chat/completions'],
  ['POST /slots/0?action=restore', '/slots/0?action=restore'],
  ['POST /slots/0?action=save', '/slots/0?action=save'],
]);
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'proxy-authorization', 'proxy-authenticate', 'host', 'content-length']);

// What the launcher hands over (Set-ChildLlmEnvironment in Launcher.Llm.ps1), or
// null when it was started without -WithLLM.
export function llmConfigFromEnv(env, dataDir) {
  if (!env.IA_LLM_SERVER || !env.IA_LLM_MODEL) return null;
  const idle = Number(env.REPORT_GENERATOR_IDLE_SECONDS);
  return {
    exe: env.IA_LLM_SERVER,
    model: env.IA_LLM_MODEL,
    alias: env.IA_LLM_ALIAS || 'model',
    slotsDir: join(dataDir, 'llm-slots'),
    dataDir,
    idleSeconds: Number.isFinite(idle) && env.REPORT_GENERATOR_IDLE_SECONDS !== '' ? idle : 900,
    readyTimeoutMs: (Number(env.REPORT_GENERATOR_READY_TIMEOUT) || 600) * 1000,
  };
}

// Starting with -WithLLM is asking for custom reports, so they default to on.
// An explicit FEATURE_CUSTOM_REPORTS in the environment still wins, and so does
// an admin's toggle in Admin → Experimental (featureFlags.js reads that first).
export function llmFeatureEnv(env) {
  return env.FEATURE_CUSTOM_REPORTS ? {} : { FEATURE_CUSTOM_REPORTS: 'true' };
}

// The same flags the Docker image starts llama-server with (Dockerfile.report-
// generator CMD; llmPins.guard.test.js keeps the two in step), plus the loopback
// address and port only this supervisor knows.
export function serverArgs(cfg, port) {
  return ['-m', cfg.model, '--alias', cfg.alias, '-c', '8192', '-np', '1',
    '--slot-save-path', cfg.slotsDir, '--no-slots', '--host', HOST, '--port', String(port)];
}

export function authorised(header, apiKey) {
  if (!apiKey) return true;
  const got = Buffer.from(header || '');
  const want = Buffer.from(`Bearer ${apiKey}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function modelList(alias, state) {
  return { object: 'list', data: [{ id: alias, object: 'model', owned_by: 'llamacpp', loaded: state === 'ready', state }] };
}

// One GET to the child; resolves to the status code, or 0 when nothing answers.
function probe(port, path, timeoutMs = 2000) {
  return new Promise(resolve => {
    const req = httpRequest({ host: HOST, port, path, method: 'GET', timeout: timeoutMs }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The llama-server child: started on demand, stopped when idle. Requests that
// arrive while it starts share one start.
export class Model {
  constructor({ cfg, apiKey, port, spawn = nodeSpawn, healthy = () => probe(port, '/health').then(s => s === 200),
    now = Date.now, pollMs = 250, writePid = defaultWritePid, logStream = defaultLogStream }) {
    Object.assign(this, { cfg, apiKey, port, spawn, healthy, now, pollMs, writePid, logStream });
    this.proc = null;
    this.starting = null;
    this.inFlight = 0;
    this.lastUsed = now();
    this.state = 'unloaded';
  }

  alive() { return this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null; }

  currentState() {
    if (this.state === 'ready' && !this.alive()) return 'unloaded';
    return this.state;
  }

  async acquire() {
    this.inFlight++;
    this.lastUsed = this.now();
    try {
      if (!this.alive() || this.state !== 'ready') {
        this.starting ??= this.#start().finally(() => { this.starting = null; });
        await this.starting;
      }
    } catch (err) {
      this.inFlight--;
      throw err;
    }
  }

  release() {
    this.inFlight--;
    this.lastUsed = this.now();
  }

  stopIfIdle(idleSeconds) {
    if (idleSeconds <= 0 || this.inFlight > 0 || this.starting || !this.alive()) return false;
    if (this.now() - this.lastUsed < idleSeconds * 1000) return false;
    this.stop();
    return true;
  }

  stop() {
    if (this.alive()) this.proc.kill();
    this.proc = null;
    this.state = 'unloaded';
    this.writePid(this.cfg.dataDir, null);
  }

  async #start() {
    this.state = 'starting';
    mkdirSync(this.cfg.slotsDir, { recursive: true });
    const proc = this.spawn(this.cfg.exe, serverArgs(this.cfg, this.port), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // llama-server reads its key from LLAMA_API_KEY only (see the Dockerfile).
      env: { ...process.env, LLAMA_API_KEY: this.apiKey },
    });
    this.proc = proc;
    const log = this.logStream(this.cfg.dataDir);
    if (log) { proc.stdout?.pipe(log); proc.stderr?.pipe(log); }
    this.writePid(this.cfg.dataDir, proc.pid);
    let failed = null;
    proc.once('error', err => { failed = err; });
    const deadline = this.now() + this.cfg.readyTimeoutMs;
    while (!(await this.healthy())) {
      if (failed || proc.exitCode !== null) {
        this.proc = null;
        this.state = 'unloaded';
        this.writePid(this.cfg.dataDir, null);
        throw new Error(failed ? `the model server could not be started: ${failed.message}`
          : `the model server exited while starting (code ${proc.exitCode}); see ${LOG_FILE}`);
      }
      if (this.now() > deadline) {
        this.stop();
        throw new Error('the model server did not become ready in time');
      }
      await sleep(this.pollMs);
    }
    this.state = 'ready';
  }
}

function defaultWritePid(dataDir, pid) {
  const file = join(dataDir, PID_FILE);
  try {
    if (pid) writeFileSync(file, String(pid)); else rmSync(file, { force: true });
  } catch { /* cleanup by pid is best effort; the exit handler still stops the child */ }
}

// The model server's own output, overwritten on each start. The file is opened
// asynchronously, so a failure arrives as an 'error' event; unhandled, that would
// end node.exe — the whole app — over a log file.
export function defaultLogStream(dataDir) {
  const stream = createWriteStream(join(dataDir, LOG_FILE), { flags: 'w' });
  stream.on('error', () => {});
  return stream;
}

// One request to the model server; the whole response is read (no streaming).
function forward(port, method, upstream, headers, body) {
  return new Promise((resolve, reject) => {
    const out = {};
    for (const [k, v] of Object.entries(headers)) if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
    if (body.length) out['content-length'] = String(body.length);
    const req = httpRequest({ host: HOST, port, path: upstream, method, headers: out, timeout: FORWARD_TIMEOUT_MS }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body.length ? body : undefined);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { req.pause(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, headers, data) {
  for (const [k, v] of Object.entries(headers)) if (!HOP_BY_HOP.has(k.toLowerCase())) res.setHeader(k, v);
  res.setHeader('content-length', String(data.length));
  res.writeHead(status);
  res.end(data);
}

const json = (res, status, payload) => send(res, status, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(payload)));

export function makeHandler(model, apiKey, alias, { forwardFn = forward } = {}) {
  return async (req, res) => {
    const path = req.url.split('?', 1)[0];
    const upstream = UPSTREAM_ROUTES.get(`${req.method} ${req.url}`);
    if (path === '/health') return json(res, 200, { status: 'ok', model: model.currentState() });
    if (!authorised(req.headers.authorization, apiKey)) {
      req.resume();
      return json(res, 401, { error: { message: 'Invalid API Key', type: 'authentication_error' } });
    }
    if (path === '/v1/models' || path === '/models') { req.resume(); return json(res, 200, modelList(alias, model.currentState())); }
    if (!upstream) { req.resume(); return json(res, 404, { error: { message: 'Not found' } }); }
    const body = await readBody(req);
    if (body === null) { res.setHeader('connection', 'close'); return json(res, 413, { error: { message: 'Request body too large' } }); }
    try {
      await model.acquire();
    } catch (err) {
      return json(res, 503, { error: { message: err.message } });
    }
    try {
      const r = await forwardFn(model.port, req.method, upstream, req.headers, body);
      send(res, r.status, r.headers, r.data);
    } catch {
      json(res, 502, { error: { message: 'the model server did not answer' } });
    } finally {
      model.release();
    }
  };
}

// A loopback port nothing is using right now, for llama-server.
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, HOST, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// Starts the supervisor on a free loopback port. Returns the environment the API
// reads (llamacpp.js and featureFlags.js) and a stop() for shutdown.
export async function startLlmSupervisor(cfg, { proc = process, log = console.log, modelOptions = {} } = {}) {
  const apiKey = randomBytes(24).toString('base64url');
  const model = new Model({ cfg, apiKey, port: await freePort(), ...modelOptions });
  const server = createServer(makeHandler(model, apiKey, cfg.alias));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, HOST, resolve); });
  const reaper = setInterval(() => {
    if (model.stopIfIdle(cfg.idleSeconds)) log(`Report model unloaded after ${cfg.idleSeconds}s unused.`);
  }, REAP_INTERVAL_MS);
  reaper.unref();
  server.unref();
  const stop = () => { clearInterval(reaper); model.stop(); server.close(); };
  // 'exit' handlers must be synchronous; kill() is (TerminateProcess on Windows).
  proc.on('exit', stop);
  log(`Report model: ${cfg.alias}, loaded on first use` +
    (cfg.idleSeconds > 0 ? `, unloaded after ${cfg.idleSeconds}s unused.` : '.'));
  return {
    model, server, stop,
    env: {
      NL_REPORTS_LLM_BACKEND: 'llamacpp',
      NL_REPORTS_LLM_URL: `http://${HOST}:${server.address().port}`,
      NL_REPORTS_LLM_API_KEY: apiKey,
    },
  };
}
