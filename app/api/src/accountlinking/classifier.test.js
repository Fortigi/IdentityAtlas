import { describe, it, expect } from 'vitest';
import { classifyAccount, emailLocalPart, normalizeName, stripKnownPrefixes } from './classifier.js';
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
