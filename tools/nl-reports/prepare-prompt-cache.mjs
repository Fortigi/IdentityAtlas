#!/usr/bin/env node
// Prepare the report generator's prompt cache (PROTOTYPE).
//
// The model has to read the ~4k-token system prompt once; the result is saved next
// to the model server and restored in milliseconds on every later start. Because
// the system prompt is release-stable (deployment values are sent with the question,
// not baked in), this can be done ONCE when the release image is built — customers
// then never wait for it.
//
// Run it against a started stack (API + model server):
//   node tools/nl-reports/prepare-prompt-cache.mjs [--base http://localhost:3001] [--timeout 1800]
//
// It is idempotent: when a cache for this model + prompt already exists it just
// restores it and exits in under a second. The API also starts this in the
// background on boot, so this script is for image builds and for operators who
// want to know when it is done.

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));

const BASE = (args.base || process.env.IA_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const DEADLINE = Date.now() + Number(args.timeout || 1800) * 1000;
const POLL_MS = 5000;

async function post(path, body = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

const started = Date.now();
const seconds = () => ((Date.now() - started) / 1000).toFixed(0);

let first = await post('/nl-reports/warm');
while (first.state === 'preparing') {
  if (Date.now() > DEADLINE) {
    console.error(`prompt cache still not ready after ${seconds()}s — giving up`);
    process.exit(1);
  }
  console.log(`preparing… ${seconds()}s`);
  await new Promise(r => setTimeout(r, POLL_MS));
  first = await post('/nl-reports/warm');
}

console.log(first.restored
  ? `prompt cache restored for ${first.model} in ${(first.ms / 1000).toFixed(1)}s — nothing to do`
  : `prompt cache prepared for ${first.model} in ${(first.ms / 1000).toFixed(0)}s`);

// Prove it: a restart-equivalent restore must be fast.
const check = await post('/nl-reports/warm', { force: true });
console.log(`verify: restored=${check.restored} in ${(check.ms / 1000).toFixed(2)}s`);
if (check.restored !== true) {
  console.error('the cache does not restore — a cold start would read the whole prompt again');
  process.exit(1);
}
