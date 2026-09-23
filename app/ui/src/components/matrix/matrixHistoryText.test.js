// How a saved matrix's history reads. Pure wording rules — no rendering.

import { describe, it, expect } from 'vitest';
import { actorLabel, provenanceLine, eventSummary, changeLine, lastChangedLine } from './matrixHistoryText';

describe('actorLabel', () => {
  it('keeps a real actor and names an absent one rather than leaving a gap', () => {
    expect(actorLabel('anna@example.com')).toBe('anna@example.com');
    expect(actorLabel(null)).toBe('someone');
    expect(actorLabel('')).toBe('someone');
    // Whitespace is not a name either — it would render as "Created by  ".
    expect(actorLabel('   ')).toBe('someone');
  });
});

describe('provenanceLine', () => {
  it('names the creator and the last person to change it', () => {
    expect(provenanceLine({ createdBy: 'wim@example.com', updatedBy: 'anna@example.com' }))
      .toBe('Created by wim@example.com · last changed by anna@example.com');
  });

  it('does not say the creator changed it when nobody else has', () => {
    expect(provenanceLine({ createdBy: 'wim@example.com', updatedBy: 'wim@example.com' }))
      .toBe('Created by wim@example.com');
  });

  it('drops the second half when nothing records a last writer', () => {
    expect(provenanceLine({ createdBy: 'wim@example.com' })).toBe('Created by wim@example.com');
  });

  it('still reads as a sentence for a row with no attribution at all', () => {
    expect(provenanceLine({})).toBe('Created by someone');
    expect(provenanceLine()).toBe('Created by someone');
  });
});

describe('eventSummary', () => {
  it('distinguishes the first save from every change after it', () => {
    expect(eventSummary({ operation: 'created', actor: 'wim@example.com' })).toBe('wim@example.com saved this matrix');
    expect(eventSummary({ operation: 'changed', actor: 'anna@example.com' })).toBe('anna@example.com changed it');
  });

  it('does not attach a name to a deletion', () => {
    expect(eventSummary({ operation: 'deleted', actor: null })).toBe('Deleted');
  });
});

describe('changeLine', () => {
  it('shows both sides of a scalar change', () => {
    expect(changeLine({ label: 'Name', from: 'Sales', to: 'Sales EMEA' })).toBe('Name: Sales → Sales EMEA');
  });

  it('lists the parts of a filter change instead of a before/after blob', () => {
    expect(changeLine({ label: 'Matrix contents', parts: ['subjects', 'roll-up'] }))
      .toBe('Matrix contents: subjects, roll-up');
  });

  it('prefers the parts over from/to when an event carries both', () => {
    expect(changeLine({ label: 'Matrix contents', parts: ['subjects'], from: 'a', to: 'b' }))
      .toBe('Matrix contents: subjects');
  });

  it('renders nothing for a missing change rather than throwing', () => {
    expect(changeLine(null)).toBe('');
  });
});

describe('lastChangedLine', () => {
  it('names who last changed it alongside when', () => {
    expect(lastChangedLine({ updatedAt: '2026-09-11T12:00:00Z', updatedBy: 'anna@example.com' }, '3d ago'))
      .toBe('Changed 3d ago by anna@example.com');
  });

  it('leaves the actor out rather than inventing one for an older row', () => {
    expect(lastChangedLine({ updatedAt: '2026-09-11T12:00:00Z' }, '3d ago')).toBe('Changed 3d ago');
  });

  it('says nothing at all when the row has never been stamped', () => {
    expect(lastChangedLine({ updatedBy: 'anna@example.com' }, '3d ago')).toBe('');
    expect(lastChangedLine(undefined, '3d ago')).toBe('');
  });
});
