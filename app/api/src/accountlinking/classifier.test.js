import { describe, it, expect } from 'vitest';
import { classifyAccount, emailLocalPart, normalizeName, stripKnownPrefixes, parseName, nameMatchLevel } from './classifier.js';
import { DEFAULT_RULES } from './defaultRules.js';

describe('classifyAccount', () => {
  it('detects admin accounts by prefix', () => {
    expect(classifyAccount({ email: 'adm-jdoe@x.com', displayName: 'John Doe (Admin)' }, DEFAULT_RULES).accountType).toBe('Admin');
  });
  it('detects guest accounts via #EXT#', () => {
    expect(classifyAccount({ email: 'jdoe_contoso.com#EXT#@fabrikam.onmicrosoft.com', displayName: 'John (Guest)' }, DEFAULT_RULES).accountType).toBe('Guest');
  });
  it('detects guest accounts via userType metadata', () => {
    expect(classifyAccount({ email: 'g@x.com', displayName: 'G', extendedAttributes: { userType: 'Guest' } }, DEFAULT_RULES).accountType).toBe('Guest');
  });
  it('detects service accounts', () => {
    expect(classifyAccount({ email: 'svc-backup@x.com', displayName: 'Backup Job' }, DEFAULT_RULES).accountType).toBe('Service');
  });
  it('detects shared / room mailboxes', () => {
    expect(classifyAccount({ email: 'room-a@x.com', displayName: 'Room A Conference' }, DEFAULT_RULES).accountType).toBe('Shared');
  });
  it('defaults to Secondary for a plain human account', () => {
    expect(classifyAccount({ email: 'jane@x.com', displayName: 'Jane Smith' }, DEFAULT_RULES).accountType).toBe('Secondary');
  });
});

describe('match helpers', () => {
  it('emailLocalPart lowercases and drops the domain', () => {
    expect(emailLocalPart('Foo.Bar@Example.com')).toBe('foo.bar');
  });
  it('stripKnownPrefixes strips the first matching prefix', () => {
    expect(stripKnownPrefixes('adm-jdoe', ['adm-', 'a-'])).toBe('jdoe');
    expect(stripKnownPrefixes('jdoe', ['adm-'])).toBe('jdoe');
  });
  it('normalizeName strips suffixes and non-alnum', () => {
    expect(normalizeName('John Doe (Admin)', ['(admin)'])).toBe('johndoe');
    expect(normalizeName('John  Doe')).toBe('johndoe');
  });
});

describe('parseName', () => {
  it('parses "Surname, Given" and strips qualifiers', () => {
    expect(parseName('Euson, Robin (OGD)')).toMatchObject({ given: 'robin', surname: 'euson' });
    expect(parseName('(ADM-azure) Euson, Robin')).toMatchObject({ given: 'robin', surname: 'euson' });
  });
  it('parses "Given Surname"', () => {
    expect(parseName('Robin Euson')).toMatchObject({ given: 'robin', surname: 'euson' });
  });
  it('produces an order-independent key', () => {
    expect(parseName('Euson, Robin').key).toBe(parseName('Robin Euson').key);
  });
  it('falls back to explicit given/surname fields', () => {
    expect(parseName('', 'Robin', 'Euson')).toMatchObject({ given: 'robin', surname: 'euson' });
  });
});

describe('nameMatchLevel', () => {
  const n = (dn) => parseName(dn);
  it('full match on same given + surname despite qualifiers', () => {
    expect(nameMatchLevel(n('Euson, Robin (OGD)'), n('(ADM-azure) Euson, Robin'))).toBe('full');
  });
  it('surnameInitial when only the initial matches', () => {
    expect(nameMatchLevel(parseName('', 'R', 'Euson'), n('Euson, Robin'))).toBe('surnameInitial');
  });
  it('none when surnames differ', () => {
    expect(nameMatchLevel(n('Smith, Jane'), n('Euson, Robin'))).toBe('none');
  });
});
