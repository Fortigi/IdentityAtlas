import { describe, it, expect } from 'vitest';
import { INGEST_TO_SQL, SQL_TO_XSD, localName, shortIri } from './vocabulary.js';

describe('vocabulary', () => {
  it('localName strips the ia: namespace and rejects anything else', () => {
    expect(localName('https://identityatlas.io/ontology#Principal')).toBe('Principal');
    expect(localName('https://identityatlas.io/ontologyX#Principal')).toBeNull();
    expect(localName('http://www.w3.org/2002/07/owl#Class')).toBeNull();
    expect(localName(undefined)).toBeNull();
  });

  it('shortIri prefixes the known namespaces and leaves others whole', () => {
    expect(shortIri('https://identityatlas.io/ontology#owner')).toBe('ia:owner');
    expect(shortIri('http://www.w3.org/2001/XMLSchema#string')).toBe('xsd:string');
    expect(shortIri('http://www.w3.org/1999/02/22-rdf-syntax-ns#JSON')).toBe('rdf:JSON');
    expect(shortIri('https://example.org/x')).toBe('https://example.org/x');
  });

  it('maps every SQL type an ingest type can land in to a datatype', () => {
    // A SQL type reachable from the ingest but missing from SQL_TO_XSD would make
    // every column of that type an "unknown-sql-type" finding.
    for (const sqlTypes of Object.values(INGEST_TO_SQL)) {
      for (const t of sqlTypes) expect(SQL_TO_XSD[t], t).toBeDefined();
    }
  });
});
