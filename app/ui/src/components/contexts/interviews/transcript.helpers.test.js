import { describe, it, expect } from 'vitest';
import { transcriptTurns, buildTranscriptView, primaryClaimId, markClass, KIND_STYLES } from './transcript.helpers';

const TEXT = [
  'Interviewer: Who works on the Harbour Authority account?',
  'Piet de Vries: I lead it. Jan Smit just left the account last month,',
  'and Karel worked on it in the early years.',
  '',
  '10:30 the recording restarts',
  'Piet de Vries: Everyone calls it the Port Co.',
].join('\n');

const span = (claimId, quote, from = 0) => {
  const start = TEXT.indexOf(quote, from);
  if (start < 0) throw new Error(`not in the text: ${quote}`);
  return { claimId, start, end: start + quote.length };
};

describe('transcriptTurns', () => {
  it('one turn per non-empty line; "Name:" is its speaker, a clock time or plain line has none', () => {
    const turns = transcriptTurns(TEXT);
    expect(turns.map(t => t.speaker)).toEqual(['Interviewer', 'Piet de Vries', null, null, 'Piet de Vries']);
    expect(turns.map(t => t.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('offsets point into the text: the turn, and where the words start after the speaker', () => {
    const [, piet, cont] = transcriptTurns(TEXT);
    expect(TEXT.slice(piet.start, piet.end)).toBe('Piet de Vries: I lead it. Jan Smit just left the account last month,');
    expect(TEXT.slice(piet.textStart, piet.end)).toBe('I lead it. Jan Smit just left the account last month,');
    expect(cont.textStart).toBe(cont.start);
  });

  it('a long prefix or a sentence with a colon later on is no speaker', () => {
    expect(transcriptTurns('So the plan was this: we move').map(t => t.speaker)).toEqual([null]);
    expect(transcriptTurns('One two three four five six: words').map(t => t.speaker)).toEqual([null]);
    expect(transcriptTurns('Anne-Marie van der Berg: hello').map(t => t.speaker)).toEqual(['Anne-Marie van der Berg']);
    expect(transcriptTurns('Speaker 2: hello').map(t => t.speaker)).toEqual(['Speaker 2']);
    expect(transcriptTurns('interviewer: lower case').map(t => t.speaker)).toEqual([null]);
    expect(transcriptTurns(null)).toEqual([]);
  });
});

describe('buildTranscriptView', () => {
  const pieces = (view, i) => view[i].pieces.map(p => [p.text, p.claimIds]);

  it('cuts a turn only where a claim starts or ends', () => {
    const view = buildTranscriptView(TEXT, [span('lead', 'I lead it.')]);
    expect(pieces(view, 1)).toEqual([['I lead it.', ['lead']], [' Jan Smit just left the account last month,', []]]);
    expect(pieces(view, 0)).toEqual([['Who works on the Harbour Authority account?', []]]);
  });

  it('a quote that runs over a line break is highlighted in both turns, never in the speaker column', () => {
    const view = buildTranscriptView(TEXT, [span('karel', 'last month,\nand Karel worked on it')]);
    expect(pieces(view, 1).at(-1)).toEqual(['last month,', ['karel']]);
    expect(pieces(view, 2)[0]).toEqual(['and Karel worked on it', ['karel']]);
    const intoSpeaker = buildTranscriptView(TEXT, [span('x', 'years.\n\n10:30 the')]);
    expect(pieces(intoSpeaker, 3)[0]).toEqual(['10:30 the', ['x']]);
  });

  it('overlapping quotes: each piece lists every claim covering it', () => {
    const view = buildTranscriptView(TEXT, [span('alias', 'Everyone calls it the Port Co'), span('name', 'the Port Co.')]);
    expect(pieces(view, 4)).toEqual([
      ['Everyone calls it ', ['alias']],
      ['the Port Co', ['alias', 'name']],
      ['.', ['name']],
    ]);
  });

  it('ignores an empty or out-of-range span, and takes the highlights in any order', () => {
    const late = span('late', 'Port Co');
    const view = buildTranscriptView(TEXT, [late, { claimId: 'empty', start: 5, end: 5 }, { claimId: 'out', start: TEXT.length + 3, end: TEXT.length + 9 }, span('early', 'Interviewer')]);
    expect(view.flatMap(t => t.pieces.flatMap(p => p.claimIds))).toEqual(['late']);
    // "Interviewer" is the speaker of the first turn: not highlighted in the words.
    expect(pieces(view, 0)).toEqual([['Who works on the Harbour Authority account?', []]]);
  });

  it('a claim that started in an earlier turn is still active in the next one only while it lasts', () => {
    const view = buildTranscriptView(TEXT, [span('a', 'Who works'), span('b', 'just left')]);
    expect(view[1].pieces.filter(p => p.claimIds.length).map(p => p.claimIds)).toEqual([['b']]);
  });
});

describe('primaryClaimId', () => {
  it('the shortest quote among the claims covering a piece wins; unknown ids are skipped', () => {
    const spans = new Map([['long', { start: 0, end: 30 }], ['short', { start: 10, end: 14 }]]);
    expect(primaryClaimId(['long', 'short'], spans)).toBe('short');
    expect(primaryClaimId(['short', 'long'], spans)).toBe('short');
    expect(primaryClaimId(['ghost', 'long'], spans)).toBe('long');
    expect(primaryClaimId(['ghost'], spans)).toBeNull();
  });
});

describe('markClass', () => {
  it('proposed: the kind\'s light fill with a dashed underline; confirmed or edited: its solid fill; rejected: grey, struck', () => {
    expect(markClass('membership', 'proposed')).toContain(KIND_STYLES.membership.proposed);
    expect(markClass('membership', 'proposed')).toContain('decoration-dashed');
    expect(markClass('membership', 'confirmed')).toContain(KIND_STYLES.membership.confirmed);
    expect(markClass('membership', 'edited')).toBe(markClass('membership', 'confirmed'));
    expect(markClass('membership', 'confirmed')).not.toContain('decoration-dashed');
    expect(markClass('alias', 'rejected')).toContain('line-through');
    expect(markClass('alias', 'rejected')).toBe(markClass('role', 'rejected'));
    expect(markClass('unknown', 'confirmed')).toBe(markClass('description', 'confirmed'));
  });

  it('every kind of claim has its own colour', () => {
    const swatches = Object.values(KIND_STYLES).map(s => s.swatch);
    expect(new Set(swatches).size).toBe(swatches.length);
    expect(Object.keys(KIND_STYLES)).toEqual(['role', 'roleHistory', 'membership', 'alias', 'property', 'description']);
  });
});
