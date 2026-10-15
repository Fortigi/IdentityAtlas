import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { REPO_ROOT, PATHS, main, runCheck, runGenerate } from './cli.js';
import { loadRegistry } from './registry.js';

function capture() {
  const out = { log: [], error: [] };
  return { io: { log: (m) => out.log.push(m), error: (m) => out.error.push(m) }, out };
}

// A registry whose ingest accepts one more ResourceRelationships type than the
// ontology defines — the spec's required demonstration, end to end.
function registryWithUndocumentedRelationship() {
  const registry = loadRegistry();
  const rr = registry.ingest['resource-relationships'];
  const field = rr.fields.relationshipType;
  registry.ingest['resource-relationships'] = { ...rr, fields: { ...rr.fields, relationshipType: { ...field, enum: [...field.enum, 'Mirrors'] } } };
  return registry;
}

describe('main', () => {
  it('check passes on the repository and reports the accepted known gaps', () => {
    const { io, out } = capture();
    expect(main(['check'], io)).toBe(0);
    expect(out.error).toEqual([]);
    expect(out.log).toEqual([expect.stringMatching(/^\d+ known gap\(s\) accepted/), 'Core ontology check passed.']);
  });

  it('check fails when the code accepts a relationship type the ontology does not define', () => {
    const { io, out } = capture();
    expect(main(['check'], io, { registry: registryWithUndocumentedRelationship() })).toBe(1);
    expect(out.error).toHaveLength(1);
    expect(out.error[0]).toMatch(/^Core ontology check failed — 1 finding\(s\):/);
    expect(out.error[0]).toContain('value-missing-from-ontology');
    expect(out.error[0]).toContain('resource-relationships.relationshipType');
    expect(out.error[0]).toContain('not defined in the ontology: Mirrors');
  });

  it('prints usage and exits 2 for an unknown command', () => {
    const { io, out } = capture();
    expect(main(['frobnicate'], io)).toBe(2);
    expect(out.error).toEqual(['usage: node src/ontology/cli.js <check|generate>']);
  });
});

describe('against a scratch copy of the repository files', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ia-ontology-'));
    mkdirSync(join(root, 'ontology'));
    mkdirSync(join(root, 'docs', 'reference'), { recursive: true });
    cpSync(join(REPO_ROOT, PATHS.ontology), join(root, PATHS.ontology));
    cpSync(join(REPO_ROOT, PATHS.config), join(root, PATHS.config));
    writeFileSync(join(root, 'docs', 'model.md'), ['# M', '<!-- BEGIN GENERATED: ontology core-erd -->', 'old', '<!-- END GENERATED: ontology core-erd -->', ''].join('\n'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('generate writes the reference page and the regions, then reports nothing to do', () => {
    const first = runGenerate({ root });
    expect(first).toEqual({ errors: [], changed: [PATHS.reference, 'docs/model.md'] });
    expect(readFileSync(join(root, 'docs', 'model.md'), 'utf8')).toContain('```mermaid\nerDiagram\n');
    expect(runGenerate({ root })).toEqual({ errors: [], changed: [] });
    const { io, out } = capture();
    expect(main(['generate'], io, { root })).toBe(0);
    expect(out.log).toEqual(['Generated docs already up to date.']);
    expect(runCheck({ root }).errors).toEqual([]);
  });

  it('check reports a missing and then a stale reference page', () => {
    runGenerate({ root });
    rmSync(join(root, PATHS.reference));
    expect(runCheck({ root }).errors.map(e => [e.code, e.message])).toEqual([['reference-stale', 'the generated reference page is missing — run npm run ontology:generate']]);
    writeFileSync(join(root, PATHS.reference), '# old\n');
    expect(runCheck({ root }).errors.map(e => [e.code, e.message])).toEqual([['reference-stale', 'out of date with the ontology — run npm run ontology:generate']]);
  });

  it('check reports a Turtle syntax error and nothing else', () => {
    writeFileSync(join(root, PATHS.ontology), '@prefix ia: <https://identityatlas.io/ontology#> .\nia:Broken a');
    const { errors, accepted, inventory } = runCheck({ root });
    expect(errors.map(e => `${e.code} ${e.subject}`)).toEqual([`syntax ${PATHS.ontology}`]);
    expect(accepted).toEqual([]);
    expect(inventory).toEqual([]);
    expect(runGenerate({ root }).changed).toEqual([]);
  });

  it('generate fails on a region with no generator', () => {
    writeFileSync(join(root, 'docs', 'other.md'), ['<!-- BEGIN GENERATED: ontology nope -->', '<!-- END GENERATED: ontology nope -->'].join('\n'));
    const { io, out } = capture();
    expect(main(['generate'], io, { root })).toBe(1);
    expect(out.error[0]).toContain('diagram-unknown-generator');
    expect(out.error[0]).toContain('docs/other.md');
  });
});
