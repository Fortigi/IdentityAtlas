// Teams bot (POC) — one question, one answer.
//
// This is the flow the spec draws: resolve the caller, hand the question to the
// custom-reports pipeline with the caller's identity attached, and turn whatever
// comes back into a card. It adds NO query logic of its own — `interpret()` and
// `runSpec()` are the same functions the web report builder calls, which is the
// property the whole POC is meant to demonstrate, and the reason there is no new
// SQL path to review.
//
// Two things here are not in the web builder and belong to the bot:
//
//   1. THE CALLER. Their account id rides in the per-question context block, not
//      in the cached system prompt — that prompt is release-stable, costs
//      minutes to re-read when it changes, and its measured accuracy is a
//      published number. Per-question context is where deployment-specific
//      facts already go (buildValuesBlock), so the caller goes there too and the
//      prompt cache stays valid.
//
//   2. THE BUDGET. A chat cannot wait the way a browser tab can. The pipeline is
//      raced against a deadline and the caller is told, rather than left with a
//      silent chat — "never leave a question unanswered" is the requirement that
//      shapes every branch below.

import { applyResolveChoice, interpret, loadValues, runSpec } from '../nlreports/service.js';
import { validateSpec } from '../nlreports/spec.js';
import { resolveCaller, callerContextBlock } from './caller.js';
import { substituteCaller, needsScopeCaveat } from './callerSpec.js';
import {
  answerCard, clarifyCard, notUnderstoodCard, unknownCallerCard, timeoutCard, errorCard, welcomeCard,
  MAX_ROWS as MAX_CARD_ROWS, MAX_COLUMNS as MAX_CARD_COLUMNS,
} from './card.js';
import { detectLanguage, strings } from './text.js';
import { logConversation, newConversationId } from './log.js';
import { forLog } from '../nlreports/assistantHttp.js';
import { setPending, takePending } from './state.js';

/**
 * How long the caller waits before being told it failed.
 *
 * 420 s. The published measurements for this model on 2 vCPU are a median of
 * 49 s and a p90 of 107 s (docs/reference/report-generator.md) — but those are
 * for ONE model call, and that is the figure an earlier 180 s budget was set
 * from. A question whose first definition fails validation costs a REPAIR
 * ROUND, which is a second call of the same size: measured here at 99 s each,
 * so 200 s for a question that eventually answers correctly. A budget that cuts
 * those off reports the feature as broken when it is merely slow.
 *
 * Waiting this long is only tolerable because the chat never goes quiet: the
 * bot acknowledges the question immediately and says it is still going at
 * PROGRESS_AFTER_MS. Lower it on faster hardware.
 */
export const DEADLINE_MS = Number(process.env.TEAMS_BOT_DEADLINE_MS) || 420_000;

/** When to tell the caller it is still going. Teams drops a typing indicator well before this. */
export const PROGRESS_AFTER_MS = Number(process.env.TEAMS_BOT_PROGRESS_MS) || 45_000;

const HELP_WORDS = new Set(['help', '?', 'hulp', 'hi', 'hello', 'hallo', 'start']);

/** Is this message a request for the examples rather than a question? */
export const isHelp = (text) => HELP_WORDS.has(String(text ?? '').trim().toLowerCase());

/**
 * Race a promise against the bot's deadline.
 *
 * The losing pipeline call is NOT cancelled — there is nothing to cancel it
 * with, the model server has a single slot, and abandoning the HTTP request
 * would not free that slot any sooner. It finishes into the void while the
 * caller gets a timeout card. Worth knowing when reading the logs: a question
 * logged as `timeout` may still have produced a definition nobody saw.
 */
export async function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export const TIMED_OUT = Symbol('timed-out');

/**
 * Answer one message from a Teams conversation.
 *
 * @param {object} message
 * @param {string} message.oid             the caller's Entra object id, from the validated SSO token
 * @param {string} message.conversationId
 * @param {string} message.text
 * @param {object} [deps]                  injected for tests; defaults are the real pipeline
 * @param {(text: string) => Promise<void>} [deps.onProgress]  called once if the answer is slow
 * @returns {Promise<{attachment: object, outcome: string, conversationLogId: string|null}>}
 */
export async function answerMessage(message, deps = {}) {
  const {
    resolveCaller: resolve = resolveCaller,
    interpret: ask = interpret,
    runSpec: run = runSpec,
    log = logConversation,
    onProgress = null,
    reportLink = defaultReportLink,
    now = Date.now,
  } = deps;

  const started = now();
  const question = String(message.text ?? '').trim();
  const language = detectLanguage(question);
  const t = strings(language);
  const id = newConversationId();

  const record = (fields) => log({
    id,
    callerOid: message.oid ?? null,
    conversationId: message.conversationId ?? null,
    question,
    language,
    totalMs: now() - started,
    ...fields,
  });

  if (isHelp(question)) return { attachment: welcomeCard(language), outcome: 'help', conversationLogId: null };

  // Logged ON ARRIVAL, not only on the way out — the same thing the report
  // route does, and for the same reason. A question takes minutes, and the
  // conversation row is not written until it finishes, so without this line a
  // question in flight is indistinguishable in the logs from one that never
  // arrived. That cost an afternoon: a message that had reached the server and
  // was working looked exactly like a message that had vanished.
  console.log(`teams-bot: ask id=${id} caller=${forLog(message.oid, 64)} conversation=${forLog(message.conversationId, 64)} lang=${language} question="${forLog(question)}"`);

  // Who is asking. No match is a full stop — never a default or anonymous user.
  const caller = await resolve(message.oid);
  if (!caller) {
    console.log(`teams-bot: ask id=${id} outcome=unknown-caller ms=${now() - started}`);
    await record({ outcome: 'unknown-caller', callerPrincipalId: null });
    return { attachment: unknownCallerCard(language), outcome: 'unknown-caller', conversationLogId: id };
  }

  const progressTimer = onProgress
    ? setTimeout(() => { onProgress(t.stillWorking).catch(() => {}); }, PROGRESS_AFTER_MS)
    : null;

  try {
    const result = await withDeadline(
      resolveAnswer({ question, caller, message, ask, run }),
      DEADLINE_MS,
    );

    if (result === TIMED_OUT) {
      console.log(`teams-bot: ask id=${id} outcome=timeout ms=${now() - started}`);
      await record({ outcome: 'timeout', callerPrincipalId: caller.principalId });
      return { attachment: timeoutCard(Math.round(DEADLINE_MS / 1000), language), outcome: 'timeout', conversationLogId: id };
    }

    const answered = await finish(result, { id, record, caller, question, language, reportLink });
    console.log(`teams-bot: ask id=${id} outcome=${answered.outcome} ms=${now() - started}`);
    return answered;
  } catch (err) {
    console.error(`teams-bot: ask id=${id} outcome=failed ms=${now() - started}: ${err.message}`);
    await record({ outcome: 'failed', callerPrincipalId: caller.principalId, error: err.message });
    return { attachment: errorCard(language), outcome: 'failed', conversationLogId: id };
  } finally {
    clearTimeout(progressTimer);
  }
}

/**
 * The pipeline half: interpret (or apply the answer to a pending clarification),
 * then run. Returns a plain description of what happened for `finish` to shape.
 */
async function resolveAnswer({ question, caller, message, ask, run }) {
  const waiting = takePending(message.conversationId);

  // Answering a "did you mean …?" needs no model round trip at all: the choice
  // is applied to the definition the previous turn already produced.
  if (waiting?.kind === 'confirm') {
    const choice = toAppliedChoice(waiting.confirm, matchChoice(waiting.confirm, question));
    if (choice) {
      const values = await loadValues();
      const { ok, spec } = validateSpec(waiting.spec, values);
      const next = ok ? applyResolveChoice(spec, choice, values) : null;
      // `matchedName` carries the correction onto the card. A name that only
      // matched fuzzily is the single most expensive way a report is wrong —
      // "Jan de Vries" resolving to the other Jan produces a page of perfectly
      // formatted answers about someone else — so the card says which name it
      // ended up using rather than quietly using it.
      if (next) {
        return {
          kind: 'report',
          spec: next,
          result: await run(next),
          matchedName: { typed: waiting.confirm.name, matched: choice.name ?? choice.term },
        };
      }
    }
    // The reply did not match any offered choice — fall through and treat it as
    // a new question rather than insisting on the menu.
  }

  const history = waiting?.kind === 'clarify' ? waiting.history : [];
  const contextual = history.length ? question : `${callerContextBlock(caller)}\n\nRequest: ${question}`;
  const reply = await ask({ question: contextual, history });

  if (reply.kind === 'clarify') {
    setPending(message.conversationId, {
      kind: 'clarify',
      history: [...history, { role: 'user', content: contextual }, { role: 'assistant', content: reply.raw }],
    });
    return { kind: 'clarify', question: reply.question, options: reply.options, timing: reply.timing };
  }

  if (reply.kind === 'confirm') {
    setPending(message.conversationId, { kind: 'confirm', confirm: reply.confirm, spec: reply.spec });
    return { kind: 'confirm', confirm: reply.confirm, timing: reply.timing };
  }

  if (reply.kind !== 'report' || !reply.spec) {
    return { kind: 'not-understood', errors: reply.errors, timing: reply.timing };
  }

  // The caller's own account, substituted into the definition before it runs.
  const spec = substituteCaller(reply.spec, caller.principalId);
  return { kind: 'report', spec, timing: reply.timing, result: await run(spec) };
}

/**
 * Shape one resolved answer into a card and a log row.
 *
 * A dispatcher over four outcomes, each in its own function. They were one
 * function until it crossed the complexity ceiling, and the split is along the
 * seam that was already there: every branch writes one log row and returns one
 * card, and none of them shares state with another.
 */
async function finish(outcome, ctx) {
  const common = {
    callerPrincipalId: ctx.caller.principalId,
    modelMs: outcome.timing?.totalMs ?? outcome.timing?.total ?? null,
  };
  if (outcome.kind === 'clarify') return finishClarify(outcome, ctx, common);
  if (outcome.kind === 'confirm') return finishConfirm(outcome, ctx, common);
  if (outcome.kind === 'not-understood' || !outcome.result?.ok) return finishNotUnderstood(outcome, ctx, common);
  return finishAnswered(outcome, ctx, common);
}

/** The model asked something back. */
async function finishClarify(outcome, { id, record, language }, common) {
  await record({ ...common, outcome: 'clarified', clarification: outcome.question });
  return { attachment: clarifyCard(outcome.question, outcome.options, language), outcome: 'clarified', conversationLogId: id };
}

/**
 * A name needs confirming ("did you mean …?"). Logged as a clarification like
 * the model's own question: from the caller's side they are the same event —
 * the bot asked instead of answering — and counting them apart would make
 * "how often is it unsure?" two numbers that have to be added up by hand.
 */
async function finishConfirm(outcome, { id, record, language }, common) {
  const { message: ask, choices = [] } = outcome.confirm;
  await record({ ...common, outcome: 'clarified', clarification: ask });
  return {
    attachment: clarifyCard(ask, choices.map(c => c.name).filter(Boolean), language),
    outcome: 'clarified',
    conversationLogId: id,
  };
}

/** Nothing usable came back. The errors are logged, never shown. */
async function finishNotUnderstood(outcome, { id, record, language }, common) {
  const errors = outcome.errors ?? outcome.result?.errors ?? [];
  await record({ ...common, outcome: 'not-understood', error: errors.join('; ') || null });
  return { attachment: notUnderstoodCard(language), outcome: 'not-understood', conversationLogId: id };
}

/** Rows — possibly zero of them, which is still an answer. */
async function finishAnswered(outcome, ctx, common) {
  const { id, record, caller, question, language, reportLink } = ctx;
  const { rows, columns, explanation, truncated, elapsedMs } = outcome.result;

  await record({
    ...common,
    outcome: 'answered',
    definition: outcome.spec,
    rowCount: rows.length,
    columns: columns.map(c => c.key),
    truncated: !!truncated,
    queryMs: elapsedMs ?? null,
  });

  return {
    attachment: answerCard({
      explanation,
      columns,
      rows,
      truncated,
      language,
      notes: answerNotes(outcome, caller, question, language),
      // Only worth a link when the card cannot show the whole answer.
      link: rows.length > MAX_CARD_ROWS || columns.length > MAX_CARD_COLUMNS ? reportLink(id) : null,
    }),
    outcome: 'answered',
    conversationLogId: id,
  };
}

/**
 * The lines above the rows.
 *
 * Both are ways a well-formatted answer can be about the wrong thing — a name
 * that resolved to a different record, and a "my" question that produced a
 * directory-wide report — so both belong with the interpretation rather than
 * under the table where they would be read after the damage.
 */
function answerNotes(outcome, caller, question, language) {
  const t = strings(language);
  const { typed, matched } = outcome.matchedName ?? {};
  return [
    typed && typed !== matched ? t.fuzzy(typed, matched) : null,
    needsScopeCaveat(question, outcome.spec, caller.principalId) ? t.scopeCaveat : null,
  ].filter(Boolean);
}

/**
 * Which offered choice the caller's reply meant.
 *
 * Exact name first, then a unique substring — a manager answering "Finance"
 * should not have to retype a name Teams already showed them. Ambiguity returns
 * null and the reply is treated as a new question, which is the safe direction:
 * guessing here silently answers about the wrong record.
 *
 * Matches on `name`, which is what a confirmation's choices actually carry
 * (references.js and terms.js both build them that way) — not `displayName`,
 * which is the column on the database row they were built from.
 */
export function matchChoice(confirm, reply) {
  const choices = confirm?.choices ?? [];
  const answer = String(reply ?? '').trim().toLowerCase();
  if (!answer || choices.length === 0) return null;

  const exact = choices.find(c => String(c.name ?? '').toLowerCase() === answer);
  if (exact) return exact;

  const partial = choices.filter(c => String(c.name ?? '').toLowerCase().includes(answer));
  return partial.length === 1 ? partial[0] : null;
}

/**
 * The picked choice, in the shape `applyResolveChoice` applies.
 *
 * The two kinds of confirmation are answered differently and neither is the
 * choice object as offered: a name confirmation needs the PATH of the condition
 * it belongs to (the choice itself only knows which record was picked), and a
 * term confirmation needs the term and the fields it should match on. Building
 * this in one place is what keeps the bot's clarification behaving exactly like
 * the web builder's, which posts the same shape to /nl-reports/resolve.
 */
export function toAppliedChoice(confirm, picked) {
  if (!picked) return null;
  if (confirm.kind === 'term') {
    return { kind: 'term', term: confirm.name, fields: picked.fields, drop: confirm.drop };
  }
  return { kind: confirm.kind, path: confirm.path, name: picked.name, id: picked.id };
}

/** Where a bot answer opens in Identity Atlas. */
export function defaultReportLink(conversationLogId, base = process.env.PUBLIC_BASE_URL) {
  if (!base) return null;
  return `${String(base).replace(/\/+$/, '')}/#bot-answer:${encodeURIComponent(conversationLogId)}`;
}
