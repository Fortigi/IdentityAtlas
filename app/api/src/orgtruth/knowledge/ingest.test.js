import { describe, it, expect } from 'vitest';
import { readTranscriptRequest, prepareTranscript } from './ingest.js';

const file = (name, text) => ({ originalname: name, mimetype: 'text/plain', buffer: Buffer.from(text, 'utf8') });

describe('readTranscriptRequest', () => {
  it('takes a file or pasted text, with defaults', () => {
    const f = readTranscriptRequest({ body: {}, file: file('wim.srt', 'x') });
    expect(f.fileName).toBe('wim.srt');
    expect(f.fields).toMatchObject({ displayName: 'wim.srt', classification: 'internal', sourceType: 'interview', speaker: null, language: null });
    const t = readTranscriptRequest({ body: { text: 'Hallo', displayName: ' Gesprek ', speaker: 'Wim', language: 'nl-NL', observedAt: '2026-10-11' } });
    expect(t.buffer.toString()).toBe('Hallo');
    expect(t.fileName).toBe('pasted-transcript.txt');
    expect(t.fields).toMatchObject({ displayName: 'Gesprek', speaker: 'Wim', language: 'nl-NL', observedAt: '2026-10-11T00:00:00.000Z' });
  });

  it('refuses what it cannot store', () => {
    expect(readTranscriptRequest({ body: {}, file: file('list.xlsx', 'x') }).error).toMatch(/\.txt, \.md, \.srt or \.vtt/);
    expect(readTranscriptRequest({ body: { text: '  ' } }).error).toMatch(/No transcript/);
    expect(readTranscriptRequest({ body: { text: 'a', observedAt: 'gisteren' } }).error).toMatch(/not a date/);
    expect(readTranscriptRequest({ body: { text: 'a', classification: 'public' } }).error).toMatch(/classification/);
    expect(readTranscriptRequest({ body: { text: 'a', sourceType: 'chat' } }).error).toMatch(/sourceType/);
    expect(readTranscriptRequest({ body: { text: 'a', language: 'dutch' } }).error).toMatch(/language/);
  });
});

describe('prepareTranscript', () => {
  const fields = { language: null, speaker: 'Wim', classification: 'internal', sourceType: 'interview', note: null };

  it('canonical text, passages, hash of the BYTES, and a guessed language', () => {
    const buffer = Buffer.from('﻿Het bestuur is Wim, Gregor en Eddie. Er is ook een feestcommissie en de maten zijn gelijk.\r\n', 'utf8');
    const p = prepareTranscript({ buffer, fileName: 'a.txt', fields });
    expect(p.text.startsWith('Het bestuur')).toBe(true);
    expect(p.text.includes('\r')).toBe(false);
    expect(p.passages).toHaveLength(1);
    expect(p.metadata).toMatchObject({ format: 'text', language: 'nl', languageGuessed: true, speaker: 'Wim', passageCount: 1 });
    expect(p.sha256).toHaveLength(64);
    expect(prepareTranscript({ buffer, fileName: 'a.txt', fields }).sha256).toBe(p.sha256);
  });

  it('a given language is kept and not marked guessed', () => {
    const p = prepareTranscript({ buffer: Buffer.from('The board is three people and we are partners.'), fileName: 'a.md', fields: { ...fields, language: 'en' } });
    expect(p.metadata).toMatchObject({ format: 'markdown', language: 'en', languageGuessed: false });
  });

  it('refuses binary, invalid UTF-8 and empty text', () => {
    expect(prepareTranscript({ buffer: Buffer.from([0xff, 0xfe, 0x00]), fileName: 'a.txt', fields }).error).toMatch(/UTF-8|binary/);
    expect(prepareTranscript({ buffer: Buffer.from('a\u0000b'), fileName: 'a.txt', fields }).error).toMatch(/binary/);
    expect(prepareTranscript({ buffer: Buffer.from('  \n '), fileName: 'a.txt', fields }).error).toMatch(/empty/);
  });
});
