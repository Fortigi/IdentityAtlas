import { describe, it, expect } from 'vitest';
import { checkDiagrams, diagramInventory, erAttributes, extractMermaidBlocks, renderGeneratedRegions } from './docsDiagrams.js';
import { modelOf } from './__tests__/miniOntology.js';

const fence = (body) => ['```mermaid', body, '```'].join('\n');
const gens = { tiny: () => 'erDiagram\n    A {\n    }' };
const model = modelOf();
const check = (text) => checkDiagrams([{ path: 'p.md', text }], model, gens).map(f => `${f.code} ${f.subject}`);

describe('extractMermaidBlocks', () => {
  it('classifies by the marker on the closest non-blank line before the fence', () => {
    const text = ['# T', '<!-- ontology: out-of-scope — risk tables -->', '', fence('erDiagram'), 'text', fence('flowchart LR')].join('\n');
    expect(extractMermaidBlocks(text)).toEqual([
      { line: 4, kind: 'erDiagram', body: 'erDiagram', marker: 'out-of-scope', reason: 'risk tables' },
      { line: 8, kind: 'flowchart', body: 'flowchart LR', marker: null, reason: '' },
    ]);
  });

  it('does not take a marker from further up when other text sits in between', () => {
    const text = ['<!-- ontology: validated -->', 'a paragraph', fence('erDiagram')].join('\n');
    expect(extractMermaidBlocks(text)[0].marker).toBeNull();
  });

  it('marks a block inside a generated region with the region id', () => {
    const text = ['<!-- BEGIN GENERATED: ontology tiny -->', fence('erDiagram'), '<!-- END GENERATED: ontology tiny -->', fence('erDiagram')].join('\n');
    const blocks = extractMermaidBlocks(text);
    expect(blocks.map(b => [b.marker, b.reason])).toEqual([['generated', 'tiny'], [null, '']]);
  });
});

describe('renderGeneratedRegions', () => {
  it('replaces the region content with the generator output and keeps the rest', () => {
    const text = ['before', '<!-- BEGIN GENERATED: ontology tiny -->', 'stale', 'lines', '<!-- END GENERATED: ontology tiny -->', 'after'].join('\n');
    const { text: out, unknown } = renderGeneratedRegions(text, model, gens);
    expect(unknown).toEqual([]);
    expect(out).toBe(['before', '<!-- BEGIN GENERATED: ontology tiny -->', '```mermaid', gens.tiny(), '```', '<!-- END GENERATED: ontology tiny -->', 'after'].join('\n'));
  });

  it('leaves an unknown or unterminated region untouched and reports it', () => {
    const text = ['<!-- BEGIN GENERATED: ontology nope -->', 'x', '<!-- END GENERATED: ontology nope -->'].join('\n');
    expect(renderGeneratedRegions(text, model, gens)).toEqual({ text, unknown: ['nope'] });
    const open = ['<!-- BEGIN GENERATED: ontology tiny -->', 'x'].join('\n');
    expect(renderGeneratedRegions(open, model, gens)).toEqual({ text: open, unknown: ['tiny'] });
  });
});

describe('erAttributes', () => {
  it('reads entity blocks and the attribute name (second token) of each line', () => {
    const body = 'erDiagram\n    Principals {\n        uuid id PK\n        string displayName "x"\n    }\n    "Other" {\n        int n\n    }\n    A ||--o{ B : "r"';
    expect([...erAttributes(body)]).toEqual([['Principals', ['id', 'displayName']], ['Other', ['n']]]);
  });
});

describe('checkDiagrams', () => {
  it('ignores diagrams that cannot draw a data model', () => {
    expect(check(fence('sequenceDiagram\n  A->>B: x'))).toEqual([]);
  });

  it('fails an unmarked erDiagram or classDiagram', () => {
    expect(check(fence('erDiagram'))).toEqual(['diagram-unclassified p.md:1']);
    expect(check(fence('classDiagram'))).toEqual(['diagram-unclassified p.md:1']);
  });

  it('needs a reason to call a diagram out of scope', () => {
    expect(check(['<!-- ontology: out-of-scope -->', fence('erDiagram')].join('\n'))).toEqual(['diagram-scope-reason p.md:2']);
    expect(check(['<!-- ontology: out-of-scope — crawler tables -->', fence('erDiagram')].join('\n'))).toEqual([]);
  });

  it('validates the attributes drawn for a core table, and ignores other entities', () => {
    const body = 'erDiagram\n    Principals {\n        uuid id PK\n        string displayName\n        string nickname\n    }\n    Elsewhere {\n        string whatever\n    }';
    const findings = checkDiagrams([{ path: 'p.md', text: ['<!-- ontology: validated -->', fence(body)].join('\n') }], model, gens);
    expect(findings).toEqual([{ code: 'diagram-unknown-attribute', subject: 'p.md:2', message: 'Principals.nickname is drawn but is not a column of Principals in the ontology' }]);
  });

  it('can only validate an erDiagram', () => {
    expect(check(['<!-- ontology: validated -->', fence('classDiagram')].join('\n'))).toEqual(['diagram-validation-unsupported p.md:2']);
  });

  it('compares a generated region byte for byte', () => {
    const region = (body) => ['<!-- BEGIN GENERATED: ontology tiny -->', fence(body), '<!-- END GENERATED: ontology tiny -->'].join('\n');
    expect(check(region(gens.tiny()))).toEqual([]);
    expect(check(region(`${gens.tiny()}\n    B {\n    }`))).toEqual(['diagram-stale p.md:2']);
    expect(check(region('erDiagram').replace(/tiny/g, 'nope'))).toEqual(['diagram-unknown-generator p.md:2']);
  });
});

describe('diagramInventory', () => {
  it('lists every diagram with its classification', () => {
    const text = ['<!-- ontology: validated -->', fence('erDiagram'), fence('flowchart LR'), fence('classDiagram')].join('\n');
    expect(diagramInventory([{ path: 'd.md', text }])).toEqual([
      { path: 'd.md', line: 2, kind: 'erDiagram', classification: 'validated' },
      { path: 'd.md', line: 5, kind: 'flowchart', classification: 'out-of-scope (not a data-model diagram type)' },
      { path: 'd.md', line: 8, kind: 'classDiagram', classification: 'unclassified' },
    ]);
  });
});
