// The human-readable core model reference, generated from the ontology.
// Written to docs/reference/core-model.md by `npm run ontology:generate`; the
// check fails when the committed page differs from this output.

import { coreClassDiagram } from './mermaid.js';
import {
  columnsOf, isSubClassOf, relationshipTypesOf, schemeMembers, tableClasses, typedSubclasses, valueSetFor,
} from './model.js';

const TTL_URL = 'https://github.com/Fortigi/IdentityAtlas/blob/main/ontology/core.ttl';
const RAW_URL = 'https://raw.githubusercontent.com/Fortigi/IdentityAtlas/main/ontology/core.ttl';

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const code = (s) => `\`${s}\``;
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function table(header, rows) {
  if (rows.length === 0) return [];
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map(r => `| ${r.map(cell).join(' | ')} |`),
    '',
  ];
}

function notes(p) {
  const n = [];
  if (p.deprecated) n.push('**Retired.**');
  if (p.status) n.push(`**${p.status.charAt(0).toUpperCase()}${p.status.slice(1)}.**`);
  return n.length ? `${n.join(' ')} ` : '';
}

function columnRow(model, cls, p) {
  const values = valueSetFor(model, cls.local, p.local);
  let ref = '';
  if (p.kind === 'object') ref = `→ ${p.rangeClasses.map(r => model.classes.get(r).table).join(' / ')}`;
  else if (values) ref = values.map(code).join(', ');
  else if (cls.discriminator === p.local && cls.openVocabulary) ref = 'open vocabulary';
  const aliases = p.ingestAliases.length ? ` Ingest alias: ${p.ingestAliases.map(code).join(', ')}.` : '';
  return [code(p.local), code(`ia:${p.local}`), p.sqlType, ref, `${notes(p)}${p.comment}${aliases}`];
}

function subclassSection(model, cls) {
  const subs = typedSubclasses(model, cls.local).sort((a, b) => byName(a.typeValue, b.typeValue));
  if (!subs.length) return [];
  const kind = cls.openVocabulary
    ? `${code(cls.discriminator)} is an open vocabulary — any value is accepted. These are the values Identity Atlas itself relies on:`
    : `${code(cls.discriminator)} accepts exactly these values:`;
  const rows = subs.map(s => {
    const parents = s.superClasses.filter(x => x !== cls.local).map(x => `ia:${x}`).join(', ');
    return [code(s.typeValue), code(`ia:${s.local}`), `${parents ? `(${parents}) ` : ''}${s.comment}`];
  });
  return [kind, '', ...table(['Value', 'Class', 'Meaning'], rows)];
}

function relationshipSection(model, cls) {
  if (!cls.typeColumn) return [];
  const rels = relationshipTypesOf(model, cls.local).sort((a, b) => byName(a.typeValue, b.typeValue));
  const rows = rels.map(r => [code(r.typeValue), code(`ia:${r.local}`),
    `${r.domains.map(d => `ia:${d}`).join(' / ')} → ${r.rangeClasses.map(d => `ia:${d}`).join(' / ')}`, r.comment]);
  return [`${code(cls.typeColumn)} accepts exactly these relationship types:`, '', ...table(['Value', 'Property', 'From → to', 'Meaning'], rows)];
}

function classSection(model, cls) {
  const kind = isSubClassOf(model, cls.local, 'Edge') ? 'Edge' : 'Node';
  const lines = [`### ${cls.table}`, '', `${code(`ia:${cls.local}`)} · ${kind} table · ${cls.comment}`, ''];
  if (cls.ingestEntities.length) lines.push(`Written by the ingest API as ${cls.ingestEntities.map(code).join(', ')}.`, '');
  if (cls.identifierColumn) lines.push(`Identifier: ${code(cls.identifierColumn)} (${cls.identifierSqlType}) — the instance IRI, not a property.`, '');
  if (cls.sourceProperties.length) {
    lines.push(`Edge: ${cls.sourceProperties.map(code).join(' or ')} → ${cls.targetProperties.map(code).join(' or ')}.`, '');
  }
  lines.push(...subclassSection(model, cls), ...relationshipSection(model, cls));
  const cols = columnsOf(model, cls.local).sort((a, b) => byName(a.local, b.local));
  lines.push(...table(['Column', 'Property', 'SQL type', 'Values / references', 'Description'], cols.map(p => columnRow(model, cls, p))));
  return lines;
}

function schemeSection(model) {
  const schemes = [...new Set([...model.properties.values()].map(p => p.valueScheme).filter(Boolean))].sort(byName);
  return schemes.flatMap(s => {
    const c = model.classes.get(s);
    const usedBy = [...model.properties.values()].filter(p => p.valueScheme === s)
      .flatMap(p => p.domains.map(d => `${model.classes.get(d).table}.${p.local}`)).sort(byName);
    const rows = schemeMembers(model, s).map(i => [code(i.typeValue), code(`ia:${i.local}`), i.comment]);
    return [`### ${c.label}`, '', `${code(`ia:${s}`)} — ${c.comment} Used by ${usedBy.map(code).join(', ')}.`, '', ...table(['Value', 'Individual', 'Meaning'], rows)];
  });
}

/** The full reference page as markdown. */
export function renderReference(model) {
  const nodes = tableClasses(model).filter(c => !isSubClassOf(model, c.local, 'Edge')).sort((a, b) => byName(a.table, b.table));
  const edges = tableClasses(model).filter(c => isSubClassOf(model, c.local, 'Edge')).sort((a, b) => byName(a.table, b.table));
  return [
    '# Core Model Reference',
    '',
    '!!! info "Generated page"',
    `    Generated from [${code('ontology/core.ttl')}](${TTL_URL}) by ${code('npm run ontology:generate')} in ${code('app/api')}.`,
    '    Do not edit it by hand: CI fails when it differs from the ontology. How to change the model:',
    '    [Maintaining the Core Ontology](../contributing/maintaining-the-ontology.md).',
    '',
    `Ontology ${code(model.ontology.iri)}, version ${code(model.ontology.version)}. Namespace ${code('https://identityatlas.io/ontology#')} (prefix ${code('ia:')}).`,
    `Download the Turtle file for Protégé, a triple store or any RDF/OWL tool: [core.ttl](${RAW_URL}).`,
    '',
    'A column is identified by the property of the same name: `Principals.accountEnabled` is',
    '`ia:accountEnabled` (`https://identityatlas.io/ontology#accountEnabled`). One property serves every core table',
    'that has a column of that name; its `rdfs:domain` lists them. Why the model looks like this, and what is not',
    'in it: [Core Ontology](../architecture/core-ontology.md).',
    '',
    '## Type hierarchy and relationship types',
    '',
    '<!-- BEGIN GENERATED: ontology core-classes -->',
    '```mermaid',
    coreClassDiagram(model),
    '```',
    '<!-- END GENERATED: ontology core-classes -->',
    '',
    '## Node tables',
    '',
    ...nodes.flatMap(c => classSection(model, c)),
    '## Edge tables',
    '',
    ...edges.flatMap(c => classSection(model, c)),
    '## Value lists',
    '',
    ...schemeSection(model),
  ].join('\n').replace(/\n+$/, '\n');
}
