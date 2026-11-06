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

// Node colours, readable in light and dark docs themes; the example picture
// (example.js) uses the same palette.
export const NODE_STYLE = {
  Identity: 'fill:#7c3aed,stroke:#5b21b6,color:#fff',
  Principal: 'fill:#2563eb,stroke:#1e40af,color:#fff',
  Resource: 'fill:#059669,stroke:#047857,color:#fff',
  Context: 'fill:#d97706,stroke:#b45309,color:#fff',
  System: 'fill:#475569,stroke:#334155,color:#fff',
};

// One arrow per (from, to, label); an edge table may connect the same pair twice.
function pushUnique(lines, seen, line) {
  if (!seen.has(line)) { seen.add(line); lines.push(line); }
}

/**
 * flowchart of the five kinds of node and what connects them: an edge table is
 * a solid arrow from its source to its target (with the relationship types it
 * stores), a foreign key between node tables a dotted one.
 */
// Every (source class, target class) pair an edge table connects, labelled with
// the table and the relationship types it stores.
function edgeTableArrows(model, edge) {
  const ranges = (props) => props.flatMap(p => model.properties.get(p)?.rangeClasses ?? []);
  const types = edge.typeColumn ? relationshipTypesOf(model, edge.local).map(r => r.typeValue).sort(byName) : [];
  const text = types.length ? `${edge.table}<br/><small>${types.join(', ')}</small>` : edge.table;
  return ranges(edge.sourceProperties).flatMap(from => ranges(edge.targetProperties).map(to => `    ${from} -->|"${text}"| ${to}`));
}

function foreignKeyArrows(model, node) {
  const fks = columnsOf(model, node.local).filter(p => p.kind === 'object').sort((a, b) => byName(a.local, b.local));
  return fks.flatMap(p => p.rangeClasses.map(to => `    ${node.local} -.->|"${p.local}"| ${to}`));
}

export function coreOverviewDiagram(model) {
  const tables = tableClasses(model);
  const nodes = tables.filter(c => !isSubClassOf(model, c.local, 'Edge')).sort((a, b) => byName(a.local, b.local));
  const edges = tables.filter(c => isSubClassOf(model, c.local, 'Edge')).sort((a, b) => byName(a.table, b.table));
  const lines = ['flowchart LR', ...nodes.map(n => `    ${n.local}["${n.label}<br/><small>${n.table}</small>"]:::${n.local}`)];
  const seen = new Set();
  for (const line of [...edges.flatMap(e => edgeTableArrows(model, e)), ...nodes.flatMap(n => foreignKeyArrows(model, n))]) {
    pushUnique(lines, seen, line);
  }
  lines.push(...nodes.filter(n => NODE_STYLE[n.local]).map(n => `    classDef ${n.local} ${NODE_STYLE[n.local]}`));
  return lines.join('\n');
}

export const GENERATED_DIAGRAMS = {
  'core-erd': coreErDiagram,
  'core-classes': coreClassDiagram,
  'core-overview': coreOverviewDiagram,
};
