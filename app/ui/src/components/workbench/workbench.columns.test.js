import { describe, it, expect } from 'vitest';
import {
  PEOPLE_COLUMNS, DEFAULT_COLUMNS, columnByKey, cellValues, distinctValues, matchesFilter, applyFilters, sortPeople,
  filterSummary, stickyOffsets, BLANK,
} from './workbench.columns';

const link = (kind, name, state = 'confirmed') => ({ kind, name, state, claims: [] });
const person = (key, displayName, extra = {}) => ({
  key, displayName, jobTitle: null, units: [], accounts: [{ id: `a-${key}` }], attributes: {}, knowledge: [], ...extra,
});
const tom = person('t', 'Tom', {
  jobTitle: 'Senior', units: ['Motor'], accounts: [{ id: 1 }, { id: 2 }], attributes: { department: 'Claims', systems: ['AD', 'Entra'] },
  knowledge: [link('expertise', 'Motor claims', 'proposed'), link('expertise', 'Fraud', 'confirmed'), link('duty', 'OR', 'rejected')],
});
const amy = person('a', 'Amy', { jobTitle: 'Handler', attributes: { department: 'Claims' }, knowledge: [link('expertise', 'motor  CLAIMS', 'disputed')] });
const kim = person('k', 'Kim', { attributes: {} });
const people = [tom, amy, kim];
const col = (k) => columnByKey.get(k);

describe('columns', () => {
  it('shows name, job title and the three knowledge columns by default', () => {
    expect(DEFAULT_COLUMNS).toEqual(['displayName', 'jobTitle', 'activity', 'expertise', 'duty']);
    expect(PEOPLE_COLUMNS.filter(c => c.type === 'knowledge').map(c => c.key)).toEqual(['activity', 'expertise', 'duty']);
  });

  it('gives each shown column its sticky left offset', () => {
    expect(stickyOffsets([{ width: 190 }, { width: 130 }, { width: 170 }])).toEqual({ offsets: [0, 190, 320], total: 490 });
  });
});

describe('cellValues', () => {
  it('reads knowledge strongest first, without rejected ones, and without proposed ones when asked', () => {
    expect(cellValues(tom, col('expertise')).map(v => [v.label, v.state])).toEqual([['Fraud', 'confirmed'], ['Motor claims', 'proposed']]);
    expect(cellValues(tom, col('expertise'), false).map(v => v.label)).toEqual(['Fraud']);
    expect(cellValues(tom, col('duty'))).toEqual([]);
    expect(cellValues(amy, col('expertise'))[0].value).toBe('motor claims');
  });

  it('reads text from the person or their attributes, lists, and the account count', () => {
    expect(cellValues(tom, col('jobTitle'))).toEqual([{ value: 'Senior', label: 'Senior' }]);
    expect(cellValues(tom, col('department'))).toEqual([{ value: 'Claims', label: 'Claims' }]);
    expect(cellValues(kim, col('department'))).toEqual([]);
    expect(cellValues(tom, col('systems')).map(v => v.label)).toEqual(['AD', 'Entra']);
    expect(cellValues(tom, col('units')).map(v => v.label)).toEqual(['Motor']);
    expect(cellValues(kim, col('systems'))).toEqual([]);
    expect(cellValues(tom, col('accounts'))).toEqual([{ value: '2', label: '2' }]);
  });
});

describe('distinctValues', () => {
  it('counts people per value (one name, whatever its case), and the people without one last', () => {
    expect(distinctValues(people, col('expertise'))).toEqual([
      { value: 'fraud', label: 'Fraud', count: 1 },
      { value: 'motor claims', label: 'Motor claims', count: 2 },
      { value: BLANK, label: '(Not known)', count: 1 },
    ]);
    expect(distinctValues(people, col('expertise'), false).map(v => [v.label, v.count])).toEqual([['Fraud', 1], ['motor  CLAIMS', 1], ['(Not known)', 1]]);
    expect(distinctValues(people, col('jobTitle')).at(-1)).toEqual({ value: BLANK, label: '(Blanks)', count: 1 });
  });
});

describe('filters', () => {
  const f = (values, includeProposed = true) => ({ values: new Set(values), includeProposed });

  it('keeps a person when ANY of their values is ticked, a person without one when blanks are ticked', () => {
    expect(matchesFilter(tom, col('expertise'), f(['motor claims']))).toBe(true);
    expect(matchesFilter(tom, col('expertise'), f(['motor claims'], false))).toBe(false);
    expect(matchesFilter(kim, col('expertise'), f([BLANK]))).toBe(true);
    expect(matchesFilter(kim, col('expertise'), f(['fraud']))).toBe(false);
  });

  it('combines columns with AND, and ignores a cleared column', () => {
    expect(applyFilters(people, { expertise: f(['motor claims']), jobTitle: f(['Handler']) }).map(p => p.key)).toEqual(['a']);
    expect(applyFilters(people, { expertise: null }).map(p => p.key)).toEqual(['t', 'a', 'k']);
    expect(applyFilters(people, {})).toBe(people);
  });

  it('says the active filters in words', () => {
    expect(filterSummary({ expertise: f(['fraud', BLANK], false), jobTitle: null, department: f([]) }, people)).toEqual([
      { key: 'expertise', text: 'Expertise: Fraud, (Not known) (confirmed only)' },
      { key: 'department', text: 'Department: nothing' },
    ]);
  });
});

describe('sortPeople', () => {
  it('sorts by name without a sort, by a column either way with blanks last, a multi-value column by its strongest value', () => {
    expect(sortPeople(people, null).map(p => p.key)).toEqual(['a', 'k', 't']);
    expect(sortPeople(people, { key: 'jobTitle', dir: 'asc' }).map(p => p.key)).toEqual(['a', 't', 'k']);
    expect(sortPeople(people, { key: 'jobTitle', dir: 'desc' }).map(p => p.key)).toEqual(['t', 'a', 'k']);
    // Tom's strongest expertise is Fraud (confirmed), so he sorts before Amy's motor claims.
    expect(sortPeople(people, { key: 'expertise', dir: 'asc' }).map(p => p.key)).toEqual(['t', 'a', 'k']);
  });
});
