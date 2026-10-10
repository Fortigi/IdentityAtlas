import { describe, it, expect } from 'vitest';
import { camelCase, pascalCase, singular, squash, typeFromFileName, uniqueName, words } from './names.js';

describe('words', () => {
  it('splits at separators and at lower-to-upper changes, keeping accented letters', () => {
    expect(words('OwnerEmail')).toEqual(['Owner', 'Email']);
    expect(words('owner_e-mail address')).toEqual(['owner', 'e', 'mail', 'address']);
    expect(words('Project2Code')).toEqual(['Project2', 'Code']);
    expect(words('Café naam')).toEqual(['Café', 'naam']);
    expect(words(null)).toEqual([]);
  });
});

describe('camelCase / pascalCase', () => {
  it('builds identifiers from headers', () => {
    expect(camelCase('Owner name')).toBe('ownerName');
    expect(camelCase('BUDGET')).toBe('budget');
    expect(camelCase('start-date (UTC)')).toBe('startDateUtc');
    expect(camelCase('€ / %')).toBe('');
    expect(pascalCase('business owner')).toBe('BusinessOwner');
  });

  it('caps an identifier at 64 characters', () => {
    expect(camelCase('a'.repeat(100))).toHaveLength(64);
    expect(pascalCase('b'.repeat(100))).toHaveLength(64);
  });
});

describe('singular', () => {
  it('handles English and Dutch plurals and leaves short words and -ss alone', () => {
    expect(singular('Projects')).toBe('Project');
    expect(singular('Policies')).toBe('Policy');
    expect(singular('Projecten')).toBe('Project');
    expect(singular('Class')).toBe('Class');
    expect(singular('Bus')).toBe('Bus');
    expect(singular('Pen')).toBe('Pen');
    expect(singular('Ties')).toBe('Tie');
  });
});

describe('typeFromFileName', () => {
  it('takes the type from the file name without path, extension, dates or filler words', () => {
    expect(typeFromFileName('Projects.xlsx')).toBe('Project');
    expect(typeFromFileName('C:\\exports\\data-domains_2026-10.csv')).toBe('DataDomain');
    expect(typeFromFileName('/tmp/Projecten export.xlsx')).toBe('Project');
    expect(typeFromFileName('applications list (final).xlsx')).toBe('Application');
  });

  it('falls back to Item when nothing usable is left', () => {
    expect(typeFromFileName('2026-10-01.csv')).toBe('Item');
    expect(typeFromFileName('')).toBe('Item');
    expect(typeFromFileName(undefined)).toBe('Item');
    expect(typeFromFileName('export.csv')).toBe('Item');
  });
});

describe('uniqueName', () => {
  it('numbers a name only on collision and records what it hands out', () => {
    const taken = new Set();
    expect(uniqueName('Owner', taken)).toBe('Owner');
    expect(uniqueName('Owner', taken)).toBe('Owner2');
    expect(uniqueName('Owner', taken)).toBe('Owner3');
    expect([...taken]).toEqual(['Owner', 'Owner2', 'Owner3']);
  });

  it('keeps a numbered name within 64 characters', () => {
    const long = 'X'.repeat(64);
    const taken = new Set([long]);
    expect(uniqueName(long, taken)).toBe(`${'X'.repeat(61)}2`);
  });
});

describe('squash', () => {
  it('compares headers on letters and digits only', () => {
    expect(squash('Owner_Name')).toBe('ownername');
    expect(squash('owner name')).toBe(squash('OwnerName'));
  });
});
