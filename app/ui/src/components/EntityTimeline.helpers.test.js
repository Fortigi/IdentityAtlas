import { describe, it, expect } from 'vitest';
import { categoriesIn, withoutHidden, categoryDayLabel, burstLabel, foldBursts, BURST_MIN } from './EntityTimeline.helpers';

const joined = (name, actor = 'list upload') => ({ summary: `${name} joined (${actor})`, category: 'people', burst: { key: `people:joined:${actor}`, one: 'person joined', many: 'people joined', actor } });

describe('categoriesIn / withoutHidden', () => {
  it('lists the categories present in a fixed order, none for an entity without them', () => {
    expect(categoriesIn([{ category: 'knowledge' }, { category: 'people' }, {}, { category: 'people' }])).toEqual(['people', 'knowledge']);
    expect(categoriesIn([{ eventKind: 'attribute' }])).toEqual([]);
    expect(categoriesIn(undefined)).toEqual([]);
  });

  it('hides the chosen categories, never an event without one', () => {
    const events = [{ id: 1, category: 'people' }, { id: 2, category: 'roles' }, { id: 3 }];
    expect(withoutHidden(events, new Set(['people'])).map(e => e.id)).toEqual([2, 3]);
    expect(withoutHidden(events, new Set())).toBe(events);
    expect(withoutHidden(undefined, new Set(['people']))).toEqual([]);
  });
});

describe('categoryDayLabel', () => {
  it('counts a day by category, singular and plural', () => {
    expect(categoryDayLabel([{ category: 'roles' }, { category: 'people' }, { category: 'people' }, { category: 'structure' }])).toBe('2 people · 1 role · 1 structure');
    expect(categoryDayLabel([{ category: 'people' }, { category: 'roles' }, { category: 'roles' }, { category: 'knowledge' }])).toBe('1 person · 2 roles · 1 knowledge');
    expect(categoryDayLabel([{ eventKind: 'attribute' }])).toBeNull();
  });
});

describe('foldBursts', () => {
  it(`folds ${BURST_MIN} or more like events into one line where the first was, and leaves the rest`, () => {
    const day = [
      { summary: 'Accountable set: Tom', category: 'roles' },
      joined('A'), joined('B'), joined('C'),
      { summary: 'Renamed: x → y', category: 'structure' },
      joined('D'),
      joined('E', 'analyst'),
    ];
    const lines = foldBursts(day);
    expect(lines.map(l => (l.kind === 'burst' ? `[${l.label}: ${l.events.length}]` : l.event.summary))).toEqual([
      'Accountable set: Tom',
      '[4 people joined (list upload): 4]',
      'Renamed: x → y',
      'E joined (analyst)',
    ]);
  });

  it('keeps fewer than the minimum as single lines', () => {
    expect(foldBursts([joined('A'), joined('B'), joined('C')]).map(l => l.kind)).toEqual(['event', 'event', 'event']);
  });

  it('a burst label without an actor', () => {
    expect(burstLabel({ one: 'person left', many: 'people left' }, 1)).toBe('1 person left');
    expect(burstLabel({ one: 'person left', many: 'people left', actor: null }, 5)).toBe('5 people left');
  });
});
