// Desktop job worker — polls the API for pending crawler jobs and dispatches them
// via pwsh.exe.  Required by desktop.cjs (CJS, no import.meta.url).
'use strict';

const { spawn }        = require('child_process');
const { join }         = require('path');
const { homedir }      = require('os');
const { readFileSync } = require('fs');

const API_URL  = `http://localhost:${process.env.PORT || '3001'}/api`;
const DATA_DIR = join(homedir(), 'AppData', 'Roaming', 'IdentityAtlas');
const KEY_FILE = process.env.WORKER_KEY_FILE || join(DATA_DIR, '.builtin-worker-key');
const SCRIPTS_DIR = join(DATA_DIR, 'scripts');

const POLL_INTERVAL_MS = 30_000;
const FIRST_POLL_DELAY =  8_000;

function getApiKey() {
  try { return readFileSync(KEY_FILE, 'utf8').trim() || null; }
  catch { return null; }
}

async function claimJob(apiKey) {
  const res = await fetch(`${API_URL}/crawlers/jobs/claim`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body:    '{}',
  });
  if (!res.ok) return null;
  const body = await res.json();
  return body?.job ?? null;
}

async function markJob(apiKey, jobId, outcome, errorMessage) {
  const path = `${API_URL}/crawlers/jobs/${jobId}/${outcome}`;
  const body = outcome === 'fail' ? JSON.stringify({ errorMessage }) : '{}';
  await fetch(path, {
    method:  'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body,
  }).catch(() => {});
}

function dispatchJob(apiKey, job) {
  const appRoot = process.env.IA_APP_ROOT || SCRIPTS_DIR;
  const dispatchScript = join(appRoot, 'setup', 'docker', 'Invoke-CrawlerJob.ps1');
  const psEnv = {
    ...process.env,
    WEB_API_URL: API_URL,
    IA_APP_ROOT: appRoot,
    TRACE_DIR:   join(DATA_DIR, 'jobs'),
  };

  const ps = spawn('pwsh.exe', [
    '-NonInteractive',
    '-File',    dispatchScript,
    '-JobId',   String(job.id),
    '-JobType', job.jobType,
    '-Config',  JSON.stringify(job.config ?? {}),
    '-ApiKey',  apiKey,
  ], { env: psEnv, stdio: 'inherit' });

  ps.on('error', async (err) => {
    const msg = err.code === 'ENOENT'
      ? 'PowerShell (pwsh.exe) not found. Install PowerShell 7 from https://aka.ms/powershell to run crawlers.'
      : `Failed to start pwsh.exe: ${err.message}`;
    console.error(`[worker] job ${job.id}: ${msg}`);
    await markJob(apiKey, job.id, 'fail', msg);
  });

  ps.on('close', async (code) => {
    if (code === 0) {
      console.log(`[worker] job ${job.id} (${job.jobType}): completed`);
      await markJob(apiKey, job.id, 'complete');
    } else {
      console.error(`[worker] job ${job.id} (${job.jobType}): failed (exit ${code})`);
      await markJob(apiKey, job.id, 'fail', `pwsh.exe exited with code ${code}`);
    }
  });
}

async function pollAndDispatch() {
  const apiKey = getApiKey();
  if (!apiKey) return;

  let job;
  try {
    job = await claimJob(apiKey);
  } catch {
    return;
  }

  if (!job) return;

  console.log(`[worker] job ${job.id} (${job.jobType}): dispatching...`);
  dispatchJob(apiKey, job);
}

function startWorker() {
  setTimeout(pollAndDispatch, FIRST_POLL_DELAY);
  setInterval(pollAndDispatch, POLL_INTERVAL_MS);
  console.log('Desktop worker started (polls every 30s for crawler jobs)');
}

module.exports = { startWorker };
