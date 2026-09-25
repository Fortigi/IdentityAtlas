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
 *
 * With a `link`, the cell becomes a markdown link — Teams renders those in an
 * Adaptive Card TextBlock, which is what makes a row clickable through to the
 * record in Identity Atlas.
 */
export function formatValue(value, link) {
  if (value === null || value === undefined || value === '') return '—';
  const text = String(value);
  return link ? `[${escapeMarkdown(text)}](${link})` : text;
}

// A name containing [ or ] would otherwise end the link early and leave the
// rest of the name as loose text — "Orange - MCL [Tjongerschans]" is exactly
// the shape of name this data has.
const escapeMarkdown = (s) => s.replace(/([[\]])/g, '\\$1');

/**
 * The interpretation, as Adaptive Card blocks.
 *
 * `explainSpec` returns `{ title, lines: [{ depth, text }] }`, NOT a string —
 * rendering it as one produced a card that said "Understood as [object Object]",
 * which silently removed the one line on the card that lets a reader catch a
 * wrong answer. Indentation carries the nesting the same way the web builder
 * shows it, so the two read alike.
 */
function explanationBlocks(t, explanation, notes) {
  const head = [text(t.understoodAs, { weight: 'Bolder', size: 'Small', isSubtle: true })];
  if (typeof explanation === 'string') {
    head.push(text(explanation));
  } else if (explanation && typeof explanation === 'object') {
    head.push(text(explanation.title, { weight: 'Bolder' }));
    for (const line of explanation.lines ?? []) {
      // Indented with NON-BREAKING spaces: Adaptive Cards collapse ordinary runs
      // of spaces, so plain indentation vanishes and every nested condition reads
      // as though it were top level — the opposite of what the nesting means.
      head.push(text(`${' '.repeat((line.depth ?? 0) * 4)}• ${line.text}`, { size: 'Small', spacing: 'None' }));
    }
  }
  return [...head, ...notes.filter(Boolean).map(n => text(n, { size: 'Small', isSubtle: true }))];
}

/**
 * What one cell says, and what (if anything) it links to.
 *
 * Two different kinds of link meet here. A NAME-LIST cell holds many records —
 * "Owner of" is 27 groups — and each name links to its own group, because the
 * alternative is what this replaced: 27 names rendered as one link to the
 * account that owns them, which pointed every group at the same wrong page.
 * Any OTHER first cell is the row's own record and links there.
 *
 * `row._links` comes from the report pipeline (nlreports/service.js), which
 * selects the ids alongside the names. Splitting the displayed string on commas
 * would be the obvious alternative and is wrong: group names contain commas.
 */
function cellText(row, column, isFirst, entityUrl) {
  const links = row._links?.[column.key];
  if (links?.length) return links.map(l => formatValue(l.name, entityUrl?.(l))).join(', ');
  return formatValue(row[column.key], isFirst && row._entity ? entityUrl?.(row._entity) : null);
}

/** One header row plus one row per record, as a ColumnSet grid. */
function rowGrid(columns, rows, entityUrl) {
  const cell = (items) => ({ type: 'Column', width: 'stretch', items });
  const header = {
    type: 'ColumnSet',
    separator: true,
    columns: columns.map(c => cell([text(c.label, { weight: 'Bolder', size: 'Small', isSubtle: true })])),
  };
  const body = rows.map(row => ({
    type: 'ColumnSet',
    separator: true,
    // The first column links to the row's own record — it is the record's name
    // by convention, and a row where every cell links to the same place is
    // noise rather than navigation. A name-list cell is the exception, in any
    // position: it holds many records and links each of them separately.
    columns: columns.map((c, i) => cell([
      text(cellText(row, c, i === 0, entityUrl), { size: 'Small' }),
    ])),
  }));
  return [header, ...body];
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
export function answerCard({ explanation, columns, rows, link, notes = [], truncated = false, language = 'en', entityUrl = null }) {
  const t = strings(language);
  const shownColumns = columns.slice(0, MAX_COLUMNS);
  const hiddenColumns = columns.length - shownColumns.length;
  const shownRows = rows.slice(0, MAX_ROWS);
  const body = explanationBlocks(t, explanation, notes);

  // A zero-row answer is a real answer, and the most common way a report is
  // subtly wrong. Keeping the interpretation above it is the whole value of
  // this branch: it says "nothing matched THIS", not a bare "no results".
  if (rows.length === 0) {
    body.push(text(t.noResults, { weight: 'Bolder' }));
    return attachment(body, linkActions(t, link));
  }

  body.push(...rowGrid(shownColumns, shownRows, entityUrl));

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
/** The assistant declined: the model's one sentence, then what it can do instead. */
export function declinedCard(reason, language = 'en') {
  const t = strings(language);
  return attachment([
    text(t.declined, { weight: 'Bolder' }),
    ...(reason ? [text(reason)] : []),
    text(t.notUnderstoodHint),
    ...t.examples.map(e => text(`• ${e}`)),
  ]);
}

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
