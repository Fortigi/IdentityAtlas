import { describe, it, expect } from 'vitest';
import { guessActivityMapping, recogniseSource } from './guess.js';
import { parseCsv, headerNames } from '../upload/parse.js';
import { profileColumns } from '../upload/profile.js';

// A small table from CSV text: { profile, rows } the way analyze builds them.
function table(text) {
  const [head, ...data] = parseCsv(text, ';');
  const columns = headerNames(head);
  const rows = data.map(cells => Object.fromEntries(columns.map((c, i) => [c, (cells[i] ?? '').trim()])));
  return { profile: profileColumns(columns, rows), rows };
}

const CLOCKIFY_HEAD = 'Project;Client;Description;Task;User;Email;Tags;Billable;Start Date;Start Time;End Date;End Time;Duration (h);Duration (decimal)';
const clockify = (lines) => table([CLOCKIFY_HEAD, ...lines].join('\n'));
const LINES = [
  'Platform;Northwind Traders;Sprint review;Meetings;Vera Example;vera@example.org;internal;Yes;04/18/2026;09:00;04/18/2026;10:30;01:30:00;1.50',
  'Migration;Contoso Bakery;Mailbox move;Build;Tom Sample;tom@example.org;;No;04/02/2026;13:00;04/02/2026;15:00;02:00:00;2.00',
];

describe('recogniseSource', () => {
  it('needs five of the Clockify headers, and three of the audit log', () => {
    expect(recogniseSource(['Project', 'Client', 'User', 'Email'])).toBeNull();
    expect(recogniseSource(['Project', 'Client', 'User', 'Email', 'Start Date'])).toBe('Clockify');
    expect(recogniseSource(['CreationDate', 'UserIds'])).toBeNull();
    expect(recogniseSource(['CreationDate', 'UserIds', 'Operations'])).toBe('Microsoft 365 audit log');
  });
});

describe('guessActivityMapping — a Clockify time export', () => {
  it('maps the Client column to the sub-units when its values name them', () => {
    const { profile, rows } = clockify(LINES);
    const m = guessActivityMapping({ fileName: 'Clockify_Time_Report_Detailed.csv', profile, rows, childNames: ['Northwind Traders', 'Contoso Bakery'] });
    expect(m).toMatchObject({
      sourceLabel: 'Clockify',
      contextColumn: 'Client',
      subjectNameColumn: 'User',
      subjectEmailColumn: 'Email',
      dateColumn: 'Start Date',
      dateOrder: 'mdy',
      amountColumn: 'Duration (decimal)',
      unit: 'hours',
      kindColumn: 'Task',
    });
    expect(m.attributeColumns).toEqual(['Project', 'Description', 'Tags']);
  });

  it('maps the Project column instead when it is the one whose values are sub-units', () => {
    const { profile, rows } = clockify(LINES);
    const m = guessActivityMapping({ profile, rows, childNames: ['Platform', 'Migration', 'Something else'] });
    expect(m.contextColumn).toBe('Project');
    expect(m.attributeColumns).toContain('Client');
  });

  it('a value matching one sub-unit beats the header word of another column', () => {
    const { profile, rows } = clockify(LINES);
    expect(guessActivityMapping({ profile, rows, childNames: ['Mailbox move'] }).contextColumn).toBe('Description');
  });

  it('without sub-units there is no context column', () => {
    const { profile, rows } = clockify(LINES);
    expect(guessActivityMapping({ profile, rows, childNames: [] }).contextColumn).toBeNull();
  });

  it('with sub-units that no value names, falls back to the header that says customer', () => {
    const { profile, rows } = clockify(LINES);
    expect(guessActivityMapping({ profile, rows, childNames: ['Nobody Here'] }).contextColumn).toBe('Project');
  });

  it('takes the clock duration when there is no decimal one, and reads day-first dates as such', () => {
    const { profile, rows } = table([
      'Client;User;Start Date;Duration (h)',
      'Northwind Traders;Vera Example;18-04-2026;01:30:00',
    ].join('\n'));
    const m = guessActivityMapping({ profile, rows, childNames: ['Northwind Traders'] });
    expect(m).toMatchObject({ amountColumn: 'Duration (h)', unit: 'hours', dateOrder: 'dmy', subjectEmailColumn: null, subjectNameColumn: 'User' });
  });

  it('a Dutch export: the duration is Duur, never the Starttijd clock time', () => {
    const { profile, rows } = table([
      'Klant;Gebruiker;Startdatum;Starttijd;Duur',
      'Northwind Traders;Vera Example;18-04-2026;09:00;1,5',
    ].join('\n'));
    const m = guessActivityMapping({ profile, rows, childNames: ['Northwind Traders'] });
    expect(m).toMatchObject({ contextColumn: 'Klant', subjectNameColumn: 'Gebruiker', dateColumn: 'Startdatum', amountColumn: 'Duur', unit: 'hours' });
    expect(m.attributeColumns).toEqual([]);
  });
});

describe('guessActivityMapping — other activity logs', () => {
  it('a Microsoft 365 audit log: one event per row, the operation as the kind', () => {
    const { profile, rows } = table([
      'CreationDate;UserIds;Operations;AuditData',
      '2026-04-18T09:12:00;vera@example.org;FileModified;{}',
      '2026-04-19T10:00:00;tom@example.org;FileAccessed;{}',
    ].join('\n'));
    const m = guessActivityMapping({ fileName: 'AuditLog.csv', profile, rows });
    expect(m).toMatchObject({
      sourceLabel: 'Microsoft 365 audit log', subjectEmailColumn: 'UserIds', dateColumn: 'CreationDate',
      amountColumn: null, unit: 'events', kindColumn: 'Operations', contextColumn: null,
    });
    expect(m.attributeColumns).toEqual(['AuditData']);
  });

  it('an unknown export: the source is named after the file and an e-mail column is found by its values', () => {
    const { profile, rows } = table([
      'Wie;Wanneer;Aantal',
      'vera@example.org;18-04-2026;3',
    ].join('\n'));
    const m = guessActivityMapping({ fileName: 'library-log export 2026.csv', profile, rows });
    expect(m).toMatchObject({ sourceLabel: 'Library log', subjectEmailColumn: 'Wie', dateColumn: 'Wanneer', amountColumn: 'Aantal', unit: 'events' });
  });

  it('a file with no columns is refused', () => {
    expect(() => guessActivityMapping({ profile: [] })).toThrow(/no columns/);
  });
});
