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
import { loadExtFields } from '../nlreports/extFields.js';
import { validateSpec } from '../nlreports/spec.js';
import { resolveCaller, callerContextBlock } from './caller.js';
import { substituteCaller, needsScopeCaveat } from './callerSpec.js';
import {
  answerCard, clarifyCard, notUnderstoodCard, unknownCallerCard, timeoutCard, errorCard, welcomeCard,
  MAX_ROWS as MAX_CARD_ROWS, MAX_COLUMNS as MAX_CARD_COLUMNS,
} from './card.js';
import { detectLanguage, strings } from './text.js';
import { logConversation, newConversationId, OUTCOMES, SURFACES } from './log.js';
import { forLog } from '../nlreports/assistantHttp.js';
import { setPending, takePending, rememberAnswer, recallAnswer } from './state.js';
import {
  carriedRecords, narrowToPrevious, previousContextBlock, substitutePrevious, usedPrevious,
} from './followUp.js';

/**
 * How long the caller waits before being told it failed.
 *
 * THIS IS A TOKEN BUDGET WEARING A CLOCK. On the 2-vCPU host this was measured
 * on, the model server generates about **2 tokens per second** (llama.cpp,
 * Qwen3-4B Q4, LLAMA_ARG_THREADS=2), so what the number really buys is roughly
 * `seconds × 2` tokens of JSON across every round the question needs. Prompt
 * evaluation is seven times cheaper per token (~70 ms against ~500 ms), which
 * is why a longer PROMPT barely matters here and a longer ANSWER matters
 * enormously.
 *
 * Measured on this deployment, one definition at a time:
 *
 *   "overview of my access packages"     72 tokens    56 s   (one call)
 *   "changes to memberships for X"      464 tokens   258 s
 *      + its repair round               403 tokens   223 s   → 481 s total
 *
 * That second question is ordinary, and at 420 s it timed out by 14%. 600 s
 * covers two full-length rounds with headroom and still refuses a question that
 * has genuinely run away. The cost of raising it is honest and worth stating: a
 * question that was going to fail now fails three minutes later.
 *
 * Bounded above by the model client's own HTTP timeout (900 s,
 * NL_REPORTS_LLM_TIMEOUT_MS) — a deadline past that would be reported as a
 * connection error instead of the bot's own "that took too long" card.
 *
 * Waiting this long is only tolerable because the chat never goes quiet: the
 * bot greets the caller by name the moment the question arrives, and Teams
 * holds a typing indicator up for the rest of it (handler.js refreshes it).
 * Lower it on faster hardware — more cores is the lever that actually moves
 * this, since 2 tok/s is the hardware, not the software.
 */
export const DEADLINE_MS = Number(process.env.TEAMS_BOT_DEADLINE_MS) || 600_000;

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
 * @returns {Promise<{attachment: object, outcome: string, conversationLogId: string|null}>}
 */
export async function answerMessage(message, deps = {}) {
  const {
    resolveCaller: resolve = resolveCaller,
    interpret: ask = interpret,
    runSpec: run = runSpec,
    log = logConversation,
    reportLink = defaultReportLink,
    entityUrl = defaultEntityUrl,
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

    const answered = await finish(result, { id, record, caller, question, language, reportLink, entityUrl });
    console.log(`teams-bot: ask id=${id} outcome=${answered.outcome} ms=${now() - started}`);
    return answered;
  } catch (err) {
    console.error(`teams-bot: ask id=${id} outcome=failed ms=${now() - started}: ${err.message}`);
    await record({ outcome: 'failed', callerPrincipalId: caller.principalId, error: err.message });
    return { attachment: errorCard(language), outcome: 'failed', conversationLogId: id };
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
      // This deployment's discovered attributes: a definition that names one
      // must validate against the same set the web builder sees.
      const extFields = await loadExtFields();
      const { ok, spec } = validateSpec(waiting.spec, values, extFields);
      const next = ok ? applyResolveChoice(spec, choice, values, extFields) : null;
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

  // What the previous answer in this chat was about, so "deze groepen" means
  // something. Offered to the model, never imposed: it decides whether this
  // question refers back (followUp.previousContextBlock says when not to).
  const carried = recallAnswer(message.conversationId);
  const history = waiting?.kind === 'clarify' ? waiting.history : [];
  // Handed over BESIDE the question, never glued in front of it. While this was
  // part of the question text, the pipeline's name-matching read the caller's
  // own name out of it and "which groups do I own" came back as a report about
  // everyone called Wim. A clarification round already carries the context in
  // its history, so it is not repeated.
  const context = history.length
    ? ''
    : [callerContextBlock(caller), previousContextBlock(carried)].filter(Boolean).join('\n\n');
  const reply = await ask({ question, context, history });

  if (reply.kind === 'clarify') {
    setPending(message.conversationId, {
      kind: 'clarify',
      // The context goes into the remembered history, so the next turn still
      // knows who is asking without it being handed over again.
      history: [
        ...history,
        { role: 'user', content: context ? `${context}\n\nRequest: ${question}` : question },
        { role: 'assistant', content: reply.raw },
      ],
    });
    return { kind: 'clarify', question: reply.question, options: reply.options, timing: reply.timing, ...told(reply) };
  }

  if (reply.kind === 'confirm') {
    setPending(message.conversationId, { kind: 'confirm', confirm: reply.confirm, spec: reply.spec });
    return { kind: 'confirm', confirm: reply.confirm, timing: reply.timing, ...told(reply) };
  }

  if (reply.kind !== 'report' || !reply.spec) {
    return { kind: 'not-understood', errors: reply.errors, timing: reply.timing, ...told(reply) };
  }

  // The caller's own account, then the previous answer's records — by the
  // sentinel when the model wrote one, and otherwise by reading the question.
  // The second path is the one that carries the feature: the model reliably
  // gets the SUBJECT of a follow-up right and reliably forgets the
  // bookkeeping, so the bookkeeping is not asked of it (see followUp.js).
  const withCaller = substituteCaller(reply.spec, caller.principalId);
  const bySentinel = substitutePrevious(withCaller, carried);
  const spec = narrowToPrevious(bySentinel, carried, question);
  const followedUp = usedPrevious(withCaller, spec);

  // Whether the previous answer was offered, and what became of it. Written
  // every time, because reconstructing this afterwards meant reading report
  // definitions back out of the database to find out that the model had simply
  // not written the token.
  //
  // `repaired` is here for a different question that keeps coming up: why did
  // that take so long? On this hardware the model writes about two tokens a
  // second, so a REPAIR ROUND — a second definition of the same size — roughly
  // doubles the wait. Without this the only way to tell one round from two was
  // to divide the elapsed time by the length of the stored definition and read
  // the ratio, which is not a diagnosis anybody should have to perform twice.
  console.log(
    `teams-bot: follow-up offered=${carried?.records?.length ?? 0} kind=${carried?.kind ?? '-'} `
    + `sentinel=${usedPrevious(withCaller, bySentinel)} narrowed=${usedPrevious(bySentinel, spec)} `
    + `repaired=${reply.repaired === true}`,
  );

  const result = await run(spec);

  // What THIS answer was about, for the question after it. Written after a
  // successful run only: an answer that failed put nothing in front of the
  // caller, so there is nothing for them to refer back to, and replacing the
  // previous set with an empty one would break a follow-up to the answer
  // before it.
  const nowCarried = carriedRecords(result);
  if (nowCarried) rememberAnswer(message.conversationId, nowCarried);

  return {
    kind: 'report',
    spec,
    timing: reply.timing,
    result,
    followedUp,
    carriedCount: carried?.records?.length ?? 0,
    ...told(reply),
  };
}

/**
 * What the pipeline was told and what it replied, carried to the log. An
 * answer built without a model call (a "did you mean" applied straight to the
 * previous definition) has none of it, and records nulls.
 */
function told(reply) {
  return {
    context: reply?.context ?? null,
    raw: reply?.raw ?? null,
    repaired: typeof reply?.repaired === 'boolean' ? reply.repaired : null,
    model: reply?.model ?? null,
  };
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
    surface: SURFACES.TEAMS,
    callerPrincipalId: ctx.caller.principalId,
    modelMs: outcome.timing?.totalMs ?? outcome.timing?.total ?? null,
    context: outcome.context ?? null,
    rawReply: outcome.raw ?? null,
    repaired: outcome.repaired ?? null,
    model: outcome.model ?? null,
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
  // Its own outcome since 071: the model was unsure of a NAME, not of the
  // question, and an evaluation wants to count those apart.
  await record({ ...common, outcome: OUTCOMES.CONFIRM, clarification: ask });
  return {
    attachment: clarifyCard(ask, choices.map(c => c.name).filter(Boolean), language),
    outcome: OUTCOMES.CONFIRM,
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
  const { id, record, caller, question, language, reportLink, entityUrl } = ctx;
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
      entityUrl,
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
    // Said out loud for the same reason the interpretation line is: a caller
    // who asked "en zijn die onderdeel van een access package?" cannot
    // otherwise tell whether "die" was understood as the 27 groups above or
    // quietly ignored. Both produce a card full of well-formatted rows, and
    // only one of them answers the question that was asked.
    outcome.followedUp ? t.followedUp(outcome.carriedCount) : null,
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

/**
 * Where one record in an answer opens in Identity Atlas.
 *
 * Every row `runSpec` returns carries `_entity: { kind, id }` — the same pair
 * the web UI's detail tabs are addressed by — so a name in a card can link
 * straight through to the group, user or resource it names. The card is a
 * summary; this is how a reader gets from it to the thing itself without
 * searching for it again by name.
 *
 * Null without a PUBLIC_BASE_URL: an unlinked name beats a link to nowhere.
 */
export function defaultEntityUrl(entity, base = process.env.PUBLIC_BASE_URL) {
  if (!base || !entity?.kind || !entity?.id) return null;
  return `${String(base).replace(/\/+$/, '')}/#${encodeURIComponent(entity.kind)}:${encodeURIComponent(entity.id)}`;
}
