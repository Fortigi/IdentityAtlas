// Mermaid diagrams in the documentation, held against the ontology.
//
// Only the two Mermaid types that can draw a data model — erDiagram and
// classDiagram — are in scope. Every one of them must say what it is, on the
// line before its fence or by sitting inside a generated region:
//
//   <!-- BEGIN GENERATED: ontology core-erd --> … <!-- END GENERATED: ontology core-erd -->
//        generated from the ontology; must match the generator byte for byte
//   <!-- ontology: validated -->
//        hand-drawn; every attribute it lists for a core table must be a real
//        column of that table
//   <!-- ontology: out-of-scope — <reason> -->
//        not the core model (crawler credentials, risk tables, …)
//
// Sequence, flow, state and gantt diagrams are not data models and are never
// checked. An unmarked erDiagram / classDiagram fails, so a new data-model
// diagram cannot slip in unexamined.

import { columnsOf, tableClasses } from './model.js';

const MODEL_KINDS = new Set(['erDiagram', 'classDiagram']);
const BEGIN = /^<!--\s*BEGIN GENERATED: ontology ([\w-]+)\s*-->\s*$/;
const END = /^<!--\s*END GENERATED: ontology ([\w-]+)\s*-->\s*$/;
const MARKER = /^<!--\s*ontology:\s*(validated|out-of-scope)\b\s*[—–:-]?\s*(.*?)\s*-->\s*$/;
const FENCE = /^\s*```mermaid\s*$/;
const CLOSE = /^\s*```\s*$/;

const err = (code, subject, message) => ({ code, subject, message });

function markerBefore(lines, i) {
  for (let j = i - 1; j >= 0; j--) {
    if (lines[j].trim() === '') continue;
    const m = MARKER.exec(lines[j].trim());
    return m ? { marker: m[1], reason: m[2] } : { marker: null, reason: '' };
  }
  return { marker: null, reason: '' };
}

function readFence(lines, start) {
  let end = start + 1;
  while (end < lines.length && !CLOSE.test(lines[end])) end++;
  return { body: lines.slice(start + 1, end).join('\n'), end };
}

/** Every mermaid block in a markdown text, with its classification. */
export function extractMermaidBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let region = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (BEGIN.test(t)) { region = BEGIN.exec(t)[1]; continue; }
    if (END.test(t)) { region = null; continue; }
    if (!FENCE.test(lines[i])) continue;
    const { body, end } = readFence(lines, i);
    const kind = (body.trim().split(/\s/)[0]) || '';
    const cls = region ? { marker: 'generated', reason: region } : markerBefore(lines, i);
    blocks.push({ line: i + 1, kind, body, ...cls });
    i = end;
  }
  return blocks;
}

/**
 * Rewrite every generated region with fresh generator output. Returns the new
 * text and the ids it did not recognise (left untouched).
 */
export function renderGeneratedRegions(text, model, generators) {
  const unknown = [];
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = BEGIN.exec(lines[i].trim());
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !END.test(lines[j].trim())) j++;
    if (!generators[m[1]] || j >= lines.length) { unknown.push(m[1]); continue; }
    out.push('```mermaid', generators[m[1]](model), '```');
    i = j - 1;
  }
  return { text: out.join('\n'), unknown };
}

// Entities and their attribute names in an erDiagram body.
export function erAttributes(body) {
  const entities = new Map();
  let current = null;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    const open = /^"?([\w-]+)"?\s*\{$/.exec(line);
    if (open) { current = open[1]; entities.set(current, []); continue; }
    if (line === '}') { current = null; continue; }
    if (current && line) entities.get(current).push(line.split(/\s+/)[1]);
  }
  return entities;
}

function checkValidated(model, block, subject) {
  if (block.kind !== 'erDiagram') return [err('diagram-validation-unsupported', subject, 'only erDiagram blocks can be marked validated; mark it out-of-scope or generate it')];
  const tables = new Map(tableClasses(model).map(c => [c.table, c]));
  const out = [];
  for (const [entity, attrs] of erAttributes(block.body)) {
    const cls = tables.get(entity);
    if (!cls) continue;
    const known = new Set([cls.identifierColumn, ...columnsOf(model, cls.local).map(p => p.local)]);
    for (const a of attrs.filter(x => !known.has(x))) {
      out.push(err('diagram-unknown-attribute', subject, `${entity}.${a} is drawn but is not a column of ${entity} in the ontology`));
    }
  }
  return out;
}

function checkBlock(model, generators, block, subject) {
  if (block.marker === null) {
    return [err('diagram-unclassified', subject, `this ${block.kind} is not marked <!-- ontology: validated --> or <!-- ontology: out-of-scope — reason -->, and is not a generated region`)];
  }
  if (block.marker === 'out-of-scope') {
    return block.reason.length >= 10 ? [] : [err('diagram-scope-reason', subject, 'an out-of-scope diagram needs a reason')];
  }
  if (block.marker === 'validated') return checkValidated(model, block, subject);
  const gen = generators[block.reason];
  if (!gen) return [err('diagram-unknown-generator', subject, `no generator named "${block.reason}"`)];
  return gen(model) === block.body ? [] : [err('diagram-stale', subject, `out of date with the ontology — run npm run ontology:generate in app/api`)];
}

/**
 * Check every data-model diagram in the given docs.
 * @param files  [{ path, text }] — path is used in messages only
 */
export function checkDiagrams(files, model, generators) {
  const out = [];
  for (const { path, text } of files) {
    for (const block of extractMermaidBlocks(text).filter(b => MODEL_KINDS.has(b.kind))) {
      out.push(...checkBlock(model, generators, block, `${path}:${block.line}`));
    }
  }
  return out;
}

/** Inventory of all mermaid diagrams: [{ path, line, kind, classification }]. */
export function diagramInventory(files) {
  return files.flatMap(({ path, text }) => extractMermaidBlocks(text).map(b => ({
    path, line: b.line, kind: b.kind,
    classification: MODEL_KINDS.has(b.kind) ? (b.marker ?? 'unclassified') : 'out-of-scope (not a data-model diagram type)',
  })));
}
