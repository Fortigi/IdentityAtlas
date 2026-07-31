// Content guards for the newcomer path.
//
// The structure guard proves the docs hang together; these prove the specific
// promises of the learning path still hold — the glossary really does define the
// vocabulary, its risk-tier table still matches the code that computes tiers,
// and the home page has not drifted back into being a second install guide.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DOCS_ROOT } from './docsStructure.js';
import { tierFor } from '../riskscoring/tiers.js';

const read = page => readFileSync(join(DOCS_ROOT, page), 'utf8');

describe('glossary', () => {
  const glossary = read('start/glossary.md');

  // The vocabulary a first-time reader cannot proceed without. Adding a term to
  // the product's language means adding it here.
  const REQUIRED = [
    'System', 'Account', 'principal', 'Identity', 'Resource', 'Assignment',
    'Direct', 'Indirect', 'Eligible', 'governed', 'Ownership',
    'matrix', 'Scope', 'Context', 'Effective access', 'Risk score',
  ];

  for (const term of REQUIRED) {
    it(`defines "${term}"`, () => {
      expect(glossary).toContain(term);
    });
  }

  it('offers an A–Z index for readers arriving from search', () => {
    expect(glossary).toContain('A–Z index');
  });

  // Review feedback on #874: the glossary described Omada as a CSV export. It
  // has had a dedicated crawler (OData REST API) for some time — the same error
  // this PR corrected on the front page and missed here. SailPoint is the
  // accurate CSV example: there is no SailPoint crawler under tools/crawlers/.
  it('does not describe Omada as a CSV source', () => {
    expect(glossary).not.toMatch(/CSV export from Omada/i);
    expect(glossary, 'Omada should be named as a crawler source').toContain('Omada');
  });

  // Review feedback on #874: "principal" is this product's table name; "account"
  // is what most systems call it, and a newcomer needs the generic word too.
  it('leads with "account" and names "principal" as this product\'s term', () => {
    expect(glossary).toMatch(/##\s*2\.\s*Account/);
    expect(glossary).toContain('**Account** is the word most systems use');
  });

  // Review feedback on #874: "resource" collides across platforms — in midPoint
  // a Resource is a connected system, which maps to an IA *System*, not a
  // Resource. Without this the reader maps their vocabulary onto the wrong table.
  it('explains how "resource" differs on other platforms', () => {
    for (const platform of ['midPoint', 'Omada', 'Azure Resource Manager', 'Entra ID']) {
      expect(glossary, `resource section should map ${platform}`).toContain(platform);
    }
    expect(glossary).toMatch(/This word does not travel well/);
  });

  it('states the risk tiers exactly as the code computes them', () => {
    // Cross-check against the single source of truth (riskscoring/tiers.js) so
    // the documented cutoffs cannot drift from the badge the UI renders — the
    // exact drift the 2026-07 documentation audit found (docs said 80/60).
    const boundaries = [
      [90, 'Critical'], [70, 'High'], [40, 'Medium'], [20, 'Low'], [1, 'Minimal'], [0, 'None'],
    ];
    for (const [score, tier] of boundaries) {
      expect(tierFor(score), `tierFor(${score})`).toBe(tier);
      expect(glossary, `glossary must document the ${tier} tier`).toContain(tier);
    }
    expect(glossary).toContain('90–100');
    expect(glossary).toContain('70–89');
  });
});

describe('documentation home page', () => {
  const home = read('index.md');

  it('routes the reader instead of repeating the install instructions', () => {
    // index.md and quickstart.md used to give different install steps (one said
    // .env was needed, the other did not). Quick Start is now the only install page.
    expect(home).not.toMatch(/```(bash|powershell)/);
    expect(home).not.toContain('docker compose -f docker-compose.prod.yml');
  });

  it('starts the reader on the vocabulary', () => {
    expect(home).toContain('start/glossary.md');
  });

  it('offers a path for each audience', () => {
    for (const audience of ['Analyst', 'Operator', 'Integrator', 'Contributor']) {
      expect(home).toContain(audience);
    }
  });
});

describe('capture the flag on-ramp', () => {
  it('has a spoiler-free primer that points at the glossary', () => {
    const primer = read('demo/before-you-play.md');
    expect(primer).toContain('no answers and no spoilers');
    expect(primer).toContain('start/glossary.md');
  });

  it('keeps the answer key behind its warning', () => {
    expect(read('demo/capture-the-flag.md')).toContain('Answer key');
  });
});

describe('design archive', () => {
  it('warns that its pages do not describe current behaviour', () => {
    const archive = read('architecture/design-archive.md');
    expect(archive).toContain('not a description of the product');
    for (const page of ['context-redesign.md', 'assignment-model-redesign.md', 'rule-mining-discussion.md']) {
      expect(archive, `archive should list ${page}`).toContain(page);
    }
  });
});
