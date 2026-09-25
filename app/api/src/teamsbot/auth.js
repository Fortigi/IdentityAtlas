// Teams bot (POC) — establishing who is on the other end of a chat.
//
// TWO tokens matter here and they authenticate different things:
//
//   1. The Bot Framework's own token on the inbound request, which proves the
//      activity really came from the Teams channel and not from someone who
//      found /api/messages. That one is checked by the adapter before any of
//      this runs (routes/teamsBot.js) and is not this module's job.
//
//   2. The CALLER's access token, obtained through Teams SSO. That is what this
//      module gets, and it is the only acceptable evidence of who is asking.
//
// The activity itself carries `from.aadObjectId`, which looks like exactly the
// Entra object id the bot needs and would save a token exchange. It is NOT used,
// and must not be: it is a field in a JSON body, attested by nothing the caller
// could not also have influenced. A bot that trusts it answers questions about
// the directory for whoever says they are someone. The token is signed; the body
// is not.
//
// The SSO token comes from the Bot Framework token service via the OAuth
// connection configured on the Azure Bot resource, which performs the
// on-behalf-of exchange for us. It comes back with aud = api://<clientId>, and
// is then verified with the SAME rule the browser's token goes through
// (middleware/auth.js, accessTokenVerifyOptions) rather than being trusted
// because Microsoft handed it over.

import { verifyAccessToken } from '../middleware/auth.js';

/**
 * How long any single call to the Bot Framework token service may take.
 *
 * It is a network call from inside a turn, and a turn that never returns is the
 * worst failure this bot has: the chat shows nothing at all — no answer, no
 * error, not even a sign-in card — and the server logs nothing either, because
 * nothing threw. That is indistinguishable from "the message never arrived",
 * and it cost a long afternoon of looking in the wrong place. Ten seconds is far
 * more than the call needs and far less than a person will wait.
 */
export const TOKEN_SERVICE_TIMEOUT_MS = Number(process.env.TEAMS_BOT_TOKEN_TIMEOUT_MS) || 10_000;

/**
 * Reject rather than hang. Returns the promise's value, or throws on timeout.
 * The underlying call is not cancelled — there is nothing to cancel it with —
 * but the turn stops waiting on it.
 */
export async function withTokenTimeout(promise, what, ms = TOKEN_SERVICE_TIMEOUT_MS) {
  let timer;
  const bell = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, bell]);
  } finally {
    clearTimeout(timer);
  }
}

/** The OAuth connection name configured on the Azure Bot resource. */
export const CONNECTION_NAME = process.env.TEAMS_BOT_CONNECTION_NAME || 'identityatlas';

/**
 * The permission a caller needs before the bot will answer them.
 *
 * Asking is a read action, so it is `data.read.reports` — deliberately NOT the
 * `data.write.reports` the web report builder requires, which would also let
 * every pilot manager create and delete saved reports that all analysts see.
 *
 * Exactly ONE permission, and `data.write.reports` is not a substitute for it
 * even though building reports feels like it ought to imply asking. Two
 * accepted permissions would mean the deny case ("holds everything except the
 * one that matters") can no longer be stated, which is precisely what the
 * permission matrix asserts for every other gate. The seed RoleMiner role
 * carries both, so an analyst is unaffected.
 */
export const REQUIRED_PERMISSION = 'data.read.reports';

/** Does this permission set allow asking the bot a question? */
export function mayAsk(permissions) {
  if (!permissions) return false;
  return permissions.has('*') || permissions.has(REQUIRED_PERMISSION);
}

/**
 * Who is asking, from the access token OAuthPrompt obtained for them.
 *
 * Obtaining the token is no longer this module's job. `OAuthPrompt`
 * (teamsbot/signInDialog.js) owns the card, the sign-in link, the exchange and
 * the retries as one unit — hand-rolling that half failed three separate ways,
 * each silently. What is left here is the part that is genuinely ours: deciding
 * whether the person behind a verified token may ask anything, and who they are.
 *
 * @param {string|null|undefined} token  the caller's access token, from OAuthPrompt
 * @param {object} [deps]
 * @returns {Promise<{ok: true, oid: string} | {ok: false, reason: 'no-token'|'invalid-token'|'forbidden'}>}
 */
export async function callerFromToken(token, deps = {}) {
  const { verify = verifyAccessToken } = deps;

  // No token means the sign-in did not complete. Not an error, and not logged as
  // one — the prompt has already told the caller what to do about it.
  if (!token) return { ok: false, reason: 'no-token' };

  let verified;
  try {
    // Timed, because verifying means fetching the tenant's signing keys through
    // jwks-rsa inside jsonwebtoken's key callback: if that fetch never answers,
    // the callback never fires, the promise never settles, and the turn dies in
    // silence with nothing logged anywhere.
    verified = await withTokenTimeout(verify(token), 'token verification');
  } catch (err) {
    console.error(`teams-bot: SSO token rejected: ${err.message}`);
    return { ok: false, reason: 'invalid-token' };
  }

  if (!mayAsk(verified.permissions)) return { ok: false, reason: 'forbidden' };

  const oid = verified.decoded?.oid;
  // A verified token without an `oid` cannot identify a person — that is an
  // application token, not a user one. There is nobody to answer as.
  if (typeof oid !== 'string' || !oid) return { ok: false, reason: 'invalid-token' };

  return { ok: true, oid, firstName: firstNameFrom(verified.decoded) };
}

/**
 * What to call the caller when greeting them.
 *
 * From the VERIFIED token rather than a database lookup: the name is already in
 * hand at this point, it costs nothing, and it cannot disagree with the account
 * the answer is actually about. Only the first word — "Hi Kees" reads like a
 * colleague, "Hi Kees van den Berg" reads like a mail merge.
 *
 * Null when the token carries no usable name, and the greeting then simply
 * leaves the name out rather than addressing someone as "undefined".
 */
export function firstNameFrom(decoded) {
  const full = decoded?.given_name || decoded?.name || '';
  const first = String(full).trim().split(/\s+/)[0];
  return first || null;
}
