// Mermaid diagrams generated from the core ontology.
//
//   core-erd      — erDiagram of the core tables: identifiers, foreign keys and
//                   the columns that carry a type or a closed value list. The
//                   full column list is in the generated reference page.
//   core-classes  — classDiagram of the type hierarchy and the typed
//                   relationships between resource / principal classes.
//
// Output is deterministic (sorted) so the docs check can compare it byte for
// byte with what is committed.

import { columnsOf, isSubClassOf, relationshipTypesOf, tableClasses, valueSetFor } from './model.js';

const SQL_SHORT = {
  'text': 'string',
  'uuid': 'uuid',
  'integer': 'int',
  'boolean': 'bool',
  'jsonb': 'json',
  'timestamp with time zone': 'timestamptz',
  'bytea': 'bytes',
};

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function isStructural(model, cls, p) {
  return p.kind === 'object'
    || p.local === 'displayName'
    || cls.discriminator === p.local
    || cls.typeColumn === p.local
    || valueSetFor(model, cls.local, p.local) !== null;
}

function attributeComment(model, cls, p) {
  if (cls.discriminator === p.local && cls.openVocabulary) return ' "open vocabulary"';
  const values = valueSetFor(model, cls.local, p.local);
  return values ? ` "${values.join(', ')}"` : '';
}

function erEntity(model, cls) {
  const lines = [`    ${cls.table} {`];
  if (cls.identifierColumn) lines.push(`        ${SQL_SHORT[cls.identifierSqlType]} ${cls.identifierColumn} PK`);
  const cols = columnsOf(model, cls.local).filter(p => isStructural(model, cls, p)).sort((a, b) => byName(a.local, b.local));
  for (const p of cols) {
    lines.push(`        ${SQL_SHORT[p.sqlType]} ${p.local}${p.kind === 'object' ? ' FK' : ''}${attributeComment(model, cls, p)}`);
  }
  lines.push('    }');
  return lines;
}

function erLinks(model, classes) {
  const lines = [];
  for (const cls of classes) {
    const fks = columnsOf(model, cls.local).filter(p => p.kind === 'object').sort((a, b) => byName(a.local, b.local));
    for (const p of fks) {
      for (const target of p.rangeClasses) {
        lines.push(`    ${model.classes.get(target).table} |o--o{ ${cls.table} : "${p.local}"`);
      }
    }
  }
  return lines;
}

/** erDiagram of the core tables. */
export function coreErDiagram(model) {
  const classes = tableClasses(model).sort((a, b) => byName(a.table, b.table));
  return ['erDiagram', ...classes.flatMap(c => erEntity(model, c)), '', ...erLinks(model, classes)].join('\n');
}

/** classDiagram of the type hierarchy and the typed relationships. */
export function coreClassDiagram(model) {
  const nodes = [...model.classes.values()].filter(c => isSubClassOf(model, c.local, 'Node') && c.local !== 'Node');
  const lines = ['classDiagram', '    direction LR'];
  for (const c of nodes.sort((a, b) => byName(a.local, b.local))) lines.push(`    class ${c.local}`);
  for (const c of nodes) {
    for (const s of c.superClasses.filter(s => s !== 'Node')) lines.push(`    ${s} <|-- ${c.local}`);
  }
  const rels = tableClasses(model).filter(c => c.typeColumn).flatMap(e => relationshipTypesOf(model, e.local));
  for (const rel of rels.sort((a, b) => byName(a.local, b.local))) {
    for (const d of rel.domains) for (const r of rel.rangeClasses) lines.push(`    ${d} --> ${r} : ${rel.typeValue}`);
  }
  return lines.join('\n');
}

export const GENERATED_DIAGRAMS = {
  'core-erd': coreErDiagram,
  'core-classes': coreClassDiagram,
};
