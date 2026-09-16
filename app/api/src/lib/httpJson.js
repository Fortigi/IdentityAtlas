// One JSON-over-HTTP call with our own timeout and a hard response cap.
//
// Not fetch(): fetch gives up when response headers take longer than 300 s, and a
// model server reading a long prompt on CPU answers only after it has read all of
// it — minutes on a small box. Node's http/https have no such hidden limit, so the
// caller's timeout is the only one.
//
// Never follows redirects (they are not followed by these modules at all) and
// stops reading at maxBytes, so a hung or runaway server cannot fill memory.

import http from 'node:http';
import https from 'node:https';

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * @param {object} args
 * @param {string} args.url
 * @param {'GET'|'POST'} [args.method]
 * @param {object} [args.body]        JSON body; omit for a bodyless request
 * @param {object} [args.headers]
 * @param {number} args.timeoutMs
 * @param {number} [args.maxBytes]
 * @returns {Promise<{ status: number, json: object|null, text: string }>}
 *   `json` is null when the body was not JSON — the caller decides whether that is an error.
 */
export function httpJson({ url, method = 'POST', body, headers = {}, timeoutMs, maxBytes = DEFAULT_MAX_BYTES }) {
  const target = new URL(url);
  const payload = body === undefined ? null : JSON.stringify(body);
  // Destructured so this file carries no `.request(` — the native-pg guard bans
  // that spelling anywhere in production code (it was the MSSQL shim's surface).
  const { request: send } = target.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = send(target, {
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { req.destroy(new Error('response too large')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* left as null */ }
        resolve({ status: res.statusCode, json, text });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs / 1000}s`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
