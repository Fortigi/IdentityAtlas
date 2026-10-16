// Organisation truth — small helpers the T1 routers share (sources, profiles,
// runs). Kept out of the routers so each stays a list of routes.
import { UUID_RE } from '../../ingest/validation.helpers.js';
import { ListParseError } from './parse.js';

// Who did it, for uploadedBy / createdBy / triggeredBy. Auth may be off, in
// which case there is no req.user at all.
export function actorOf(req) {
  return req.user?.preferred_username ?? req.user?.oid ?? 'anonymous';
}

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// Wrap an async handler: an unexpected error is logged and answered with a
// JSON 500 naming what failed, never an HTML page or a hung request.
export function handle(what, fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error(`org-truth: failed to ${what}:`, err.message);
      if (!res.headersSent) res.status(500).json({ error: `Failed to ${what}.` });
    }
  };
}

// 400 with the validator's sentences, the shape the wizard shows per field.
export function sendInvalid(res, error, errors) {
  return res.status(400).json({ error, errors });
}

// Run a parse; a ListParseError becomes a 400 with its sentence and null.
export async function parseOr400(res, parse) {
  try {
    return await parse();
  } catch (err) {
    if (!(err instanceof ListParseError)) throw err;
    res.status(400).json({ error: err.message });
    return null;
  }
}
