import { describe, it, expect } from 'vitest';
import { profileColumns, detectShape } from './profileColumns.js';

describe('profileColumns', () => {
  const columns = ['Code', 'Owner', 'Mail', 'Empty'];
  const rows = [
    { Code: 'P-1', Owner: 'Ann', Mail: 'ann@contoso.com', Empty: '' },
    { Code: 'P-2', Owner: ' Ann ', Mail: 'bob@contoso.com', Empty: '  ' },
    { Code: 'P-3', Owner: 'ann', Mail: '', Empty: '' },
    { Code: 'P-3', Owner: '', Mail: 'not an address', Empty: '' },
    { Code: 'P-4', Owner: 'Cas', Mail: 'cas@contoso.com', Empty: '' },
    { Code: 'P-5', Owner: 'Dirk', Mail: 'dirk@contoso.com', Empty: '' },
    { Code: 'P-6', Owner: 'Eva', Mail: 'eva@contoso.com', Empty: '' },
  ];

  it('counts non-empty, distinct (trimmed, case-sensitive) and duplicate values per column', () => {
    const [code, owner, mail, empty] = profileColumns(columns, rows);
    expect(code).toMatchObject({ name: 'Code', index: 0, nonEmpty: 7, distinct: 6, duplicates: 1, uniqueness: 0.857 });
    expect(owner).toMatchObject({ index: 1, nonEmpty: 6, distinct: 5, duplicates: 1, uniqueness: 0.833 });
    expect(mail).toMatchObject({ index: 2, nonEmpty: 6, distinct: 6, duplicates: 0, uniqueness: 1, shape: 'email' });
    expect(empty).toEqual({ name: 'Empty', index: 3, nonEmpty: 0, distinct: 0, uniqueness: 0, duplicates: 0, shape: 'text', samples: [] });
  });

  it('gives up to five distinct samples in file order', () => {
    const [code, owner] = profileColumns(columns, rows);
    expect(code.samples).toEqual(['P-1', 'P-2', 'P-3', 'P-4', 'P-5']);
    expect(owner.samples).toEqual(['Ann', 'ann', 'Cas', 'Dirk', 'Eva']);
  });

  it('treats a missing key or a non-string cell as a value, not a crash', () => {
    const [a] = profileColumns(['a'], [{}, { a: 5 }, null]);
    expect(a).toMatchObject({ nonEmpty: 1, distinct: 1, shape: 'number', samples: ['5'] });
  });
});

describe('detectShape', () => {
  it('needs at least 80 % of the values to share a shape', () => {
    expect(detectShape(['a@b.nl', 'c@d.nl', 'e@f.nl', 'g@h.nl', 'x'])).toBe('email');
    expect(detectShape(['a@b.nl', 'c@d.nl', 'e@f.nl', 'x', 'y'])).toBe('text');
  });

  it('recognises booleans, numbers and dates in the forms lists use', () => {
    expect(detectShape(['Yes', 'no', 'TRUE', 'ja', 'N'])).toBe('boolean');
    expect(detectShape(['12', '-3.5', '1.234.567', '10,5', '+7', '1 000'])).toBe('number');
    expect(detectShape(['2026-10-01', '2026-01-02T00:00:00.000Z', '1-10-2026', '01/10/2026', '2026/10/1', '2026-10-01 12:00'])).toBe('date');
  });

  it('calls everything else, and an empty column, text', () => {
    expect(detectShape([])).toBe('text');
    expect(detectShape(['Atlas', 'Beacon'])).toBe('text');
    expect(detectShape(['12a', '2026-13', 'x'])).toBe('text');
    for (const notNumber of ['1..2', '5.', '1, 2', '.5', 'a1', '1-2']) expect(detectShape([notNumber]), notNumber).toBe('text');
    for (const notDate of ['2026-10-01X', '2026-10-0', '2026-10-01Tnoon']) expect(detectShape([notDate]), notDate).toBe('text');
    expect(detectShape(['a@b', 'x@y z.com'])).toBe('text');
  });
});
