import { describe, it, expect } from 'vitest';
import { detectFormat, canonicalize, segment, guessLanguage, sha256, MAX_PASSAGE_CHARS } from './segment.js';

describe('detectFormat', () => {
  it('reads the extension first, then the content', () => {
    expect(detectFormat('a.vtt', 'x')).toBe('vtt');
    expect(detectFormat('a.srt', 'x')).toBe('srt');
    expect(detectFormat('notes.md', 'x')).toBe('markdown');
    expect(detectFormat('notes.MARKDOWN', 'x')).toBe('markdown');
    expect(detectFormat('pasted.txt', 'WEBVTT\n\n00:00.000 --> 00:01.000\nhoi')).toBe('vtt');
    expect(detectFormat('pasted.txt', '1\n00:00:01,000 --> 00:00:02,000\nhoi')).toBe('srt');
    expect(detectFormat(undefined, 'gewoon tekst')).toBe('text');
  });
});

describe('canonicalize', () => {
  it('keeps plain text as uploaded, minus BOM and CR line endings', () => {
    expect(canonicalize('﻿a\r\nb\rc', 'text')).toEqual({ text: 'a\nb\nc', cues: null });
  });

  it('joins subtitle cues by newline, with speaker and times, offsets pointing into the joined text', () => {
    const srt = '1\n00:00:21,800 --> 00:00:25,000\nWim is maat.\n\n2\n00:00:25,000 --> 00:00:27,500\n<v Rob>Rob ook.</v>\n';
    const { text, cues } = canonicalize(srt, 'srt');
    expect(text).toBe('Wim is maat.\nRob: Rob ook.');
    expect(cues).toEqual([
      { startMs: 21800, endMs: 25000, speaker: null, text: 'Wim is maat.', startChar: 0, endChar: 12 },
      { startMs: 25000, endMs: 27500, speaker: 'Rob', text: 'Rob ook.', startChar: 13, endChar: 26 },
    ]);
    for (const c of cues) expect(text.slice(c.startChar, c.endChar)).toBe(c.speaker ? `${c.speaker}: ${c.text}` : c.text);
  });

  it('removes cue markup completely, also when a tag is rebuilt from the pieces of another', () => {
    const { text } = canonicalize('WEBVTT\n\n00:01.000 --> 00:02.000\n<i>Rob</i> is <<b>b>maat</b>.\n', 'vtt');
    expect(text).toBe('Rob is maat.');
  });

  it('reads VTT minute:second stamps and drops cues without text', () => {
    const { cues } = canonicalize('WEBVTT\n\n00:01.500 --> 00:02.250\nhallo\n\n00:03.000 --> 00:04.000\n\n', 'vtt');
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ startMs: 1500, endMs: 2250 });
  });
});

describe('segment', () => {
  it('cuts paragraphs into passages with offsets that slice back to the passage text', () => {
    const text = 'Wim: Eerste zin. Tweede zin.\n\nRob: Derde zin!';
    const ps = segment(text);
    expect(ps.map(p => p.text)).toEqual(['Wim: Eerste zin. Tweede zin.', 'Rob: Derde zin!']);
    expect(ps.map(p => p.seq)).toEqual([1, 2]);
    expect(ps.map(p => p.speaker)).toEqual(['Wim', 'Rob']);
    for (const p of ps) expect(text.slice(p.startChar, p.endChar)).toBe(p.text);
  });

  it('never makes a passage longer than the limit and never splits mid-word', () => {
    const sentence = 'Dit is een vrij lange zin over de organisatie van het bedrijf. ';
    const text = sentence.repeat(30).trim();
    const ps = segment(text);
    expect(ps.length).toBeGreaterThan(3);
    for (const p of ps) {
      expect(p.endChar - p.startChar).toBeLessThanOrEqual(MAX_PASSAGE_CHARS);
      expect(text.slice(p.startChar, p.endChar)).toBe(p.text);
      expect(p.text.endsWith('.')).toBe(true);
    }
  });

  it('cuts a single sentence over the limit at a space', () => {
    const text = `${'woord '.repeat(150).trim()}.`;
    const ps = segment(text);
    expect(ps.length).toBeGreaterThan(1);
    for (const p of ps) {
      expect(p.text).not.toMatch(/^\s|\s$/);
      expect(p.text.split(' ').every(w => w === 'woord' || w === 'woord.')).toBe(true);
    }
  });

  it('groups subtitle cues of one speaker and keeps the first start and last end time', () => {
    const { text, cues } = canonicalize('1\n00:00:01,000 --> 00:00:02,000\nA een.\n\n2\n00:00:02,000 --> 00:00:03,000\nA twee.\n\n3\n00:00:03,000 --> 00:00:04,000\n<v Rob>R.</v>', 'srt');
    const ps = segment(text, cues);
    expect(ps).toHaveLength(2);
    expect(ps[0]).toMatchObject({ seq: 1, startMs: 1000, endMs: 3000, speaker: null, text: 'A een.\nA twee.' });
    expect(ps[1]).toMatchObject({ seq: 2, speaker: 'Rob', text: 'Rob: R.' });
  });

  it('is deterministic', () => {
    const text = 'Een. Twee.\n\nDrie.';
    expect(segment(text)).toEqual(segment(text));
  });
});

describe('guessLanguage', () => {
  it('tells Dutch from English and abstains on too little text', () => {
    expect(guessLanguage('Het is een bedrijf en de maten zijn gelijk, maar er is ook een bestuur.')).toBe('nl');
    expect(guessLanguage('The company is a partnership and the partners are equal, but we have a board.')).toBe('en');
    expect(guessLanguage('Rob Mark')).toBeNull();
  });
});

it('sha256 is the hex digest', () => {
  expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
