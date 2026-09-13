// Shared test helpers for crawler `discover.js` handler tests.
//
// Each crawler's discover.test.js had its own identical copy of these three:
// a minimal Express-shaped req/res pair, a fetch stub that dispatches on a URL
// substring, and an `ok(payload)` response builder. jscpd counted the copies
// as clones; there is nothing crawler-specific about any of them.
//
// Used by tools/crawlers/<type>/discover.test.js, which run under the API's
// vitest — see tools/crawlers/CLAUDE.md → "JS/UI Testing".
import { vi } from 'vitest';

// A req/res pair shaped like the bit of Express a discover handler touches.
// `res.statusCode` defaults to 200 so a handler that only calls json() still
// reads as a success.
export function makeReqRes(body) {
  const req = { body };
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return { req, res };
}

// A fetch response with a JSON body.
export const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });

// Stub global fetch, dispatching by URL substring — `routes` is an array of
// [substring, response] pairs and the FIRST match wins, so a test can override
// one endpoint by listing it ahead of the happy-path set. Anything unmatched
// answers 404, which is what makes a missing stub obvious instead of silent.
export function stubFetch(routes) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url);
    for (const [match, response] of routes) {
      if (u.includes(match)) return response;
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
}
