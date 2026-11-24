// The ways in and out are a closed vocabulary declared in the ontology. Reads
// ontology/core.ttl, so it stays out of the Stryker run (see its config).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WAYS_IN, WAYS_OUT, UNKNOWN_WAY } from './businessRoleAccessModel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ttl = readFileSync(join(__dirname, '..', '..', '..', '..', 'ontology', 'core.ttl'), 'utf8');

const valuesOf = (scheme) => [...ttl.matchAll(new RegExp(`ia:${scheme}_\\w+ a owl:NamedIndividual, ia:${scheme} ; ia:typeValue "(\\w+)"`, 'g'))].map(m => m[1]);

describe('the access model and the ontology', () => {
  it('declares exactly the ways in', () => {
    expect(valuesOf('AccessWayIn').sort()).toEqual([...WAYS_IN, UNKNOWN_WAY].sort());
  });

  it('declares exactly the ways out', () => {
    expect(valuesOf('AccessWayOut').sort()).toEqual([...WAYS_OUT, UNKNOWN_WAY].sort());
  });
});
