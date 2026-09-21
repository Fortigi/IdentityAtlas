// Teams bot (POC) — what the answer looks like in the chat.
//
// Pure functions returning Adaptive Card JSON. Nothing here talks to Teams, the
// database or the model, which is what lets the card be tested for the thing
// that actually matters about it: that it never shows a column the report
// definition did not ask for, and never shows rows without saying what question
// they answer.
//
// THE INTERPRETATION LINE COMES FIRST, ALWAYS. It is not decoration. A wrong
// name match ("Jan de Vries" matching the wrong Jan) produces a card full of
// perfectly formatted, perfectly wrong rows, and the sentence above them is the
// only place a manager can catch it. Same for a fuzzy match, which is marked
// rather than silently accepted, and for a question that said "my" but produced
// a directory-wide report (see callerSpec.scopeCaveat).

import { strings } from './text.js';

export const MAX_ROWS = 10;

// Teams renders a card in a chat column that is ~400px on a phone. Past four
// columns the text wraps to unreadable slivers, so the card shows four and says
// how many it left out — the full set is one click away in Identity Atlas. This
// is truncation, stated on the card; it is not the renderer choosing columns.
export const MAX_COLUMNS = 4;

const ADAPTIVE_CARD = 'application/vnd.microsoft.card.adaptive';
const SCHEMA = 'http://adaptivecards.io/schemas/adaptive-card.json';

/** Wrap a card body as the attachment shape the Bot Framework expects. */
export function attachment(body, actions = []) {
  return {
    contentType: ADAPTIVE_CARD,
    content: {
      $schema: SCHEMA,
      type: 'AdaptiveCard',
      version: '1.5',
      body,
      ...(actions.length ? { actions } : {}),
    },
  };
}

const text = (value, opts = {}) => ({ type: 'TextBlock', text: String(value ?? ''), wrap: true, ...opts });

/**
 * A cell as the chat should read it. `runSpec` has already turned booleans into
 * Yes/No and dates into ISO days; what is left is null (which must not render as
 * the string "null") and numbers.
 */
export function formatValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

/** One header row plus one row per record, as a ColumnSet grid. */
function rowGrid(columns, rows) {
  const cell = (items) => ({ type: 'Column', width: 'stretch', items });
  const header = {
    type: 'ColumnSet',
    separator: true,
    columns: columns.map(c => cell([text(c.label, { weight: 'Bolder', size: 'Small', isSubtle: true })])),
  };
  const body = rows.map(row => ({
    type: 'ColumnSet',
    separator: true,
    columns: columns.map(c => cell([text(formatValue(row[c.key]), { size: 'Small' })])),
  }));
  return [header, ...body];
}

function interpretation(t, explanation, notes) {
  return [
    text(t.understoodAs, { weight: 'Bolder', size: 'Small', isSubtle: true }),
    text(explanation),
    ...notes.filter(Boolean).map(n => text(n, { size: 'Small', isSubtle: true })),
  ];
}

const linkActions = (t, link) => (link ? [{ type: 'Action.OpenUrl', title: t.openReport, url: link }] : []);

/**
 * The answer card.
 *
 * @param {object} args
 * @param {string} args.explanation   explainSpec() output — what the bot understood
 * @param {{key: string, label: string}[]} args.columns
 * @param {object[]} args.rows        every matching row; the card shows the first MAX_ROWS
 * @param {string} [args.link]        deep link into Identity Atlas for the full report
 * @param {string[]} [args.notes]     fuzzy-match marks, scope caveats
 * @param {boolean} [args.truncated]  the query itself hit its row cap
 * @param {string} [args.language]
 */
export function answerCard({ explanation, columns, rows, link, notes = [], truncated = false, language = 'en' }) {
  const t = strings(language);
  const shownColumns = columns.slice(0, MAX_COLUMNS);
  const hiddenColumns = columns.length - shownColumns.length;
  const shownRows = rows.slice(0, MAX_ROWS);
  const body = interpretation(t, explanation, notes);

  // A zero-row answer is a real answer, and the most common way a report is
  // subtly wrong. Keeping the interpretation above it is the whole value of
  // this branch: it says "nothing matched THIS", not a bare "no results".
  if (rows.length === 0) {
    body.push(text(t.noResults, { weight: 'Bolder' }));
    return attachment(body, linkActions(t, link));
  }

  body.push(...rowGrid(shownColumns, shownRows));

  const remarks = [
    rows.length > shownRows.length ? t.showing(shownRows.length, rows.length) : t.records(rows.length),
    hiddenColumns > 0 ? t.moreColumns(hiddenColumns) : null,
    truncated ? t.rowLimit : null,
  ].filter(Boolean);
  body.push(text(remarks.join(' '), { size: 'Small', isSubtle: true }));

  return attachment(body, linkActions(t, link));
}

/**
 * The card sent on install, and by `help`.
 *
 * The three examples are not arbitrary: they are the question shapes the report
 * generator measurably handles best — list questions per person, per group and
 * per resource. Comparisons, its weakest kind at 3 of 6
 * (docs/reference/report-generator.md), are deliberately not advertised here,
 * because an example is a promise.
 */
export function welcomeCard(language = 'en') {
  const t = strings(language);
  return attachment([
    text(t.title, { weight: 'Bolder', size: 'Medium' }),
    text(t.welcome),
    ...t.examples.map(e => text(`• ${e}`)),
    text(t.welcomeFooter, { size: 'Small', isSubtle: true }),
  ]);
}

/** One clarifying question, with the model's own options listed under it. */
export function clarifyCard(question, options = [], language = 'en') {
  return attachment([
    text(question),
    ...(options.length ? [text(options.map(o => `• ${o}`).join('\n'), { size: 'Small' })] : []),
  ].filter(Boolean));
}

/**
 * The could-not-understand reply.
 *
 * Shows the examples again rather than an error, because "I did not understand"
 * without a way forward is where a pilot user stops using the bot.
 */
export function notUnderstoodCard(language = 'en') {
  const t = strings(language);
  return attachment([
    text(t.notUnderstood, { weight: 'Bolder' }),
    text(t.notUnderstoodHint),
    ...t.examples.map(e => text(`• ${e}`)),
  ]);
}

/** The caller is not in Identity Atlas at all. */
export function unknownCallerCard(language = 'en') {
  const t = strings(language);
  return attachment([text(t.unknownCaller, { weight: 'Bolder' }), text(t.unknownCallerHint)]);
}

/** The generator did not answer inside the budget. */
export function timeoutCard(seconds, language = 'en') {
  const t = strings(language);
  return attachment([text(t.timeout, { weight: 'Bolder' }), text(t.timeoutHint(seconds))]);
}

/** Anything else that went wrong. */
export function errorCard(language = 'en') {
  const t = strings(language);
  return attachment([text(t.error, { weight: 'Bolder' }), text(t.errorHint)]);
}
