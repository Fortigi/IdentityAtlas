import { describe, it, expect } from 'vitest';
import { checkActivityMapping, MAX_SOURCE_LABEL } from './mapping.js';

const COLUMNS = ['Client', 'User', 'Email', 'Start Date', 'Duration (decimal)', 'Task', 'Description'];
const good = {
  sourceLabel: ' Clockify ', contextColumn: 'Client', emptyContext: 'skip', subjectNameColumn: 'User', subjectEmailColumn: 'Email',
  dateColumn: 'Start Date', dateOrder: 'mdy', amountColumn: 'Duration (decimal)', unit: 'hours', kindColumn: 'Task',
  attributeColumns: ['Description', 'Description'],
};

describe('checkActivityMapping', () => {
  it('normalises a complete mapping and finds nothing wrong', () => {
    const { mapping, errors } = checkActivityMapping(good, COLUMNS, { hasChildren: true });
    expect(errors).toEqual([]);
    expect(mapping).toEqual({ ...good, sourceLabel: 'Clockify', attributeColumns: ['Description'] });
  });

  it('refuses a column the file does not have', () => {
    const { errors, mapping } = checkActivityMapping({ ...good, kindColumn: 'Project' }, COLUMNS, { hasChildren: true });
    expect(errors).toEqual(['The kind column "Project" is not in the file.']);
    expect(mapping.kindColumn).toBeNull();
  });

  it('needs a source, a date and at least one way to name the person', () => {
    const { errors } = checkActivityMapping({ ...good, sourceLabel: '  ', dateColumn: '', subjectNameColumn: null, subjectEmailColumn: '' }, COLUMNS, { hasChildren: true });
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/source/);
    expect(errors[1]).toMatch(/date/);
    expect(errors[2]).toMatch(/person/);
  });

  it('either person column alone is enough', () => {
    expect(checkActivityMapping({ ...good, subjectNameColumn: null }, COLUMNS, { hasChildren: true }).errors).toEqual([]);
    expect(checkActivityMapping({ ...good, subjectEmailColumn: null }, COLUMNS, { hasChildren: true }).errors).toEqual([]);
  });

  it('a sub-unit column is refused on a context without sub-units', () => {
    expect(checkActivityMapping(good, COLUMNS, { hasChildren: false }).errors).toEqual([expect.stringMatching(/no units below it/)]);
    expect(checkActivityMapping({ ...good, contextColumn: null }, COLUMNS).errors).toEqual([]);
  });

  it('rows without a unit go to this unit unless they are left out', () => {
    expect(checkActivityMapping(good, COLUMNS, { hasChildren: true }).mapping.emptyContext).toBe('skip');
    for (const v of [undefined, 'self', 'elsewhere', 1]) {
      expect(checkActivityMapping({ ...good, emptyContext: v }, COLUMNS, { hasChildren: true }).mapping.emptyContext, String(v)).toBe('self');
    }
  });

  it('one column cannot play two roles', () => {
    const { errors } = checkActivityMapping({ ...good, kindColumn: 'Client' }, COLUMNS, { hasChildren: true });
    expect(errors).toEqual(['The column "Client" cannot be both the sub-unit and the kind.']);
  });

  it('drops an attribute column that a role already takes', () => {
    const { mapping } = checkActivityMapping({ ...good, attributeColumns: ['Task', 'Description'] }, COLUMNS, { hasChildren: true });
    expect(mapping.attributeColumns).toEqual(['Description']);
  });

  it('without an amount column the unit is events, whatever was sent', () => {
    expect(checkActivityMapping({ ...good, amountColumn: null, unit: 'hours' }, COLUMNS, { hasChildren: true }).mapping.unit).toBe('events');
    expect(checkActivityMapping({ ...good, unit: 'events' }, COLUMNS, { hasChildren: true }).mapping.unit).toBe('events');
    expect(checkActivityMapping({ ...good, unit: 'parsecs' }, COLUMNS, { hasChildren: true }).mapping.unit).toBe('hours');
  });

  it('defaults an unknown date order to day-first and caps the source label', () => {
    const { mapping } = checkActivityMapping({ ...good, dateOrder: 'ymd', sourceLabel: 'x'.repeat(MAX_SOURCE_LABEL + 5) }, COLUMNS, { hasChildren: true });
    expect(mapping.dateOrder).toBe('dmy');
    expect(mapping.sourceLabel).toHaveLength(MAX_SOURCE_LABEL);
  });

  it('treats anything that is not an object as an empty mapping', () => {
    for (const input of [null, 'Client', ['Client']]) {
      const { errors, mapping } = checkActivityMapping(input, COLUMNS);
      expect(errors).toHaveLength(3);
      expect(mapping.attributeColumns).toEqual([]);
    }
  });
});
