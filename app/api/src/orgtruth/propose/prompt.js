// Organisation truth — the model's system prompt and reply grammar for a recipe proposal.
//
// The model sees only the column PROFILE of an uploaded list (headers, value shapes,
// counts, three short samples per column) and proposes the object-relation model: which
// columns are entities, which are attributes, how the entities relate, and how each is
// matched to the system truth. It never writes rows: service.js validates the reply with
// the shared contracts and falls back to the heuristic.
//
// Byte-stable (no deployment data), so the report generator can keep a saved prompt cache
// of it next to the other assistants' (nlreports/warmup.js). The allowed target fields and
// signal types are generated from contracts.js, never retyped, so the prompt cannot drift
// from what the validators accept.
//
// The two few-shot examples are deliberately AWAY from what the proposal is evaluated on
// (projects with owners): a small model copies an example almost word for word when the
// input resembles it, which would make the evaluation measure the example, not the model
// (docs/architecture/context-assistant.md section 7). Facility assets with a caretaker and
// cost centres with a controller exercise the same shapes with different words.

import { LINK_RULES_JSON_SCHEMA, LINK_TARGETS, RECIPE_JSON_SCHEMA, SIGNAL_TYPES } from '../contracts.js';

export const MAX_NOTES = 8;
export const MAX_NOTE = 200;
export const MAX_SAMPLES = 3;
export const MAX_SAMPLE = 40;
// The model's context is 8,192 tokens; a profile line is ~30 tokens, so 60 columns stay
// well inside what is left after the system prompt and the reply.
export const MAX_COLUMNS_IN_PROMPT = 60;

// Every array is bounded (the recipe and link-rule schemas bound theirs): the grammar is
// what stops a small model at temperature 0 from repeating itself until the token cap.
export const RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  required: ['recipe', 'linkRules', 'notes'],
  properties: {
    recipe: RECIPE_JSON_SCHEMA,
    linkRules: LINK_RULES_JSON_SCHEMA,
    notes: { type: 'array', maxItems: MAX_NOTES, items: { type: 'string', maxLength: MAX_NOTE } },
  },
});

const col = (name, shape, nonEmpty, distinct, samples) => ({ name, shape, nonEmpty, distinct, samples });

export const EXAMPLES = Object.freeze([
  {
    fileName: 'Facility assets.xlsx',
    columns: [
      col('AssetTag', 'text', 220, 220, ['FA-00121', 'FA-00122', 'FA-00187']),
      col('Description', 'text', 220, 214, ['Freight lift north wing', 'Cold store 2', 'Badge reader hall B']),
      col('Building', 'text', 218, 6, ['North wing', 'Hall B', 'Depot']),
      col('Caretaker', 'text', 205, 18, ['R. Okafor', 'L. de Smet', 'J. Novak']),
      col('CaretakerMail', 'email', 205, 18, ['r.okafor@northwind.example', 'l.desmet@northwind.example', 'j.novak@northwind.example']),
    ],
    reply: {
      recipe: {
        version: 1,
        entities: [
          { type: 'Asset', keyColumn: 'AssetTag', nameColumn: 'Description', attributes: [{ column: 'Building', name: 'building' }] },
          { type: 'Caretaker', nameColumn: 'Caretaker', attributes: [{ column: 'CaretakerMail', name: 'email' }] },
        ],
        relations: [{ predicate: 'caretaker', from: 'Asset', to: 'Caretaker' }],
      },
      linkRules: [
        { entityType: 'Caretaker', targetType: 'Principal', threshold: 50, signals: [
          { attribute: 'email', targetField: 'email', type: 'exact', weight: 90 },
          { attribute: 'displayName', targetField: 'displayName', type: 'name', weight: 60 },
        ] },
      ],
      notes: ['AssetTag is unique on every row, so it is the key of Asset.', 'Caretaker and CaretakerMail describe one person per asset.'],
    },
  },
  {
    fileName: 'kostenplaatsen.csv',
    columns: [
      col('Kostenplaats', 'number', 64, 64, ['4100', '4110', '5200']),
      col('Omschrijving', 'text', 64, 64, ['Salarissen', 'Inhuur', 'Huisvesting']),
      col('Controller', 'text', 64, 9, ['M. Visser', 'A. Haddad', 'P. Kowalski']),
      col('ControllerPersNr', 'number', 64, 9, ['100231', '100877', '101402']),
      col('Budget', 'number', 60, 58, ['125000', '48000', '310000']),
    ],
    reply: {
      recipe: {
        version: 1,
        entities: [
          { type: 'CostCentre', keyColumn: 'Kostenplaats', nameColumn: 'Omschrijving', attributes: [{ column: 'Budget', name: 'budget' }] },
          { type: 'Controller', keyColumn: 'ControllerPersNr', nameColumn: 'Controller', attributes: [{ column: 'ControllerPersNr', name: 'employeeId' }] },
        ],
        relations: [{ predicate: 'controller', from: 'CostCentre', to: 'Controller' }],
      },
      linkRules: [
        { entityType: 'Controller', targetType: 'Identity', threshold: 50, signals: [
          { attribute: 'employeeId', targetField: 'employeeId', type: 'exact', weight: 90 },
          { attribute: 'displayName', targetField: 'displayName', type: 'name', weight: 50 },
        ] },
        { entityType: 'CostCentre', targetType: 'Context', threshold: 70, signals: [
          { attribute: 'displayName', targetField: 'displayName', type: 'exact', weight: 80 },
        ] },
      ],
      notes: ['The personnel number identifies the controller, so it is matched to identities on employeeId.'],
    },
  },
]);

const clip = (value, max) => {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** One line per column: name, shape, counts, up to three samples of at most 40 characters. */
export function describeColumn(c) {
  const samples = (Array.isArray(c.samples) ? c.samples : []).slice(0, MAX_SAMPLES).map(s => JSON.stringify(clip(s, MAX_SAMPLE)));
  return `- ${JSON.stringify(clip(c.name, 120))} | ${c.shape || 'text'} | nonEmpty ${Number(c.nonEmpty) || 0} | distinct ${Number(c.distinct) || 0} | samples: ${samples.join(', ') || '(none)'}`;
}

/** The user message: the file name and the column profile. */
export function buildUserMessage({ fileName, columns }) {
  const shown = columns.slice(0, MAX_COLUMNS_IN_PROMPT);
  const more = columns.length - shown.length;
  return [
    `File: ${JSON.stringify(clip(fileName || '(unnamed)', 120))}`,
    'Columns:',
    ...shown.map(describeColumn),
    ...(more > 0 ? [`(${more} more columns not shown; leave them out of the recipe.)`] : []),
  ].join('\n');
}

const targetLines = () => Object.entries(LINK_TARGETS).map(([t, fields]) => `- ${t}: ${fields.join(', ')}`).join('\n');

/** The system prompt. Identical for every deployment of a release — no data in it. */
export function buildPrompt() {
  const examples = EXAMPLES.map(e => `Input:\n${buildUserMessage(e)}\nReply: ${JSON.stringify(e.reply)}`).join('\n\n');
  return `You help an analyst of Identity Atlas, an identity and access governance tool, read an organisation list (a spreadsheet the organisation keeps, not a system export). You see the column profile only. You propose the object-relation model of the list and how each kind of object is matched to the accounts, groups and contexts the tool already knows. The analyst reviews and edits your proposal. Reply with JSON only.

# Recipe rules
1. An entity is a kind of thing a row describes (a type in PascalCase, singular). Each entity type appears once. Its "nameColumn" is the column that names it; "keyColumn" is a column unique on every row, when there is one.
2. Every column in the recipe must be one of the listed columns, spelled exactly. A column that describes an entity is one of its "attributes" (a short camelCase "name").
3. A person mentioned in a row (a name, an e-mail address or a personnel number) is its own entity, typed by its role in the row, with its e-mail column as attribute "email" or its personnel number as attribute "employeeId".
4. A relation links two entity types of the same row: "predicate" is the role in camelCase, "from" the main entity, "to" the other.

# Link rules
One rule per entity type that can be found in the tool. "attribute" is "displayName" (the entity's name) or one of its attribute names. "targetType" and "targetField" must be one of:
${targetLines()}
Signal "type" is one of: ${SIGNAL_TYPES.join(', ')}. "weight" is 1 to 100; "threshold" is the summed weight a match needs (usually 50). People go to Principal (accounts) or Identity (persons); groups to Resource; departments, teams and other named units to Context.

# Notes
At most ${MAX_NOTES} short sentences that explain your choices to the analyst.

# Examples
${examples}`;
}
