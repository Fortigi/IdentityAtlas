// Reading a transcript: each format's own noise goes, the words and who said
// them stay, and every refusal is a sentence.
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  parseTranscript, detectTranscriptFormat, decodeText, documentXmlToText, decodeXmlEntities,
  vttToText, srtToText, tidyText, TranscriptError, MAX_TRANSCRIPT_CHARS,
} from './transcript.js';

const buf = (s) => Buffer.from(s, 'utf8');

async function docx(documentXml) {
  const zip = new JSZip();
  zip.file('word/document.xml', documentXml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const VTT = `WEBVTT

NOTE recorded by the meeting tool

1
00:00:01.000 --> 00:00:04.000
<v Anna Voorbeeld>Yes, I am the owner of this application,

2
00:00:04.000 --> 00:00:07.500
<v Anna Voorbeeld>but Piet does most of the day-to-day.

3
00:00:08.000 --> 00:00:10.000
<v Interviewer>Since when?

00:00:10.000 --> 00:00:12.000
<v.loud Anna Voorbeeld><b>Since 2021.</b>
`;

const SRT = `1
00:00:01,000 --> 00:00:03,000
Bram Test: I worked there early on

2
00:00:03,000 --> 00:00:05,000
Bram Test: <i>as a junior.</i>

3
00:00:05,500 --> 00:00:07,000
Then I left.
`;

describe('detectTranscriptFormat', () => {
  it('reads the content before the name', () => {
    expect(detectTranscriptFormat(buf(VTT), 'notes.txt')).toBe('vtt');
    expect(detectTranscriptFormat(buf(SRT), 'notes.txt')).toBe('srt');
    expect(detectTranscriptFormat(buf('Just words'), 'interview.srt')).toBe('srt');
    expect(detectTranscriptFormat(buf('Just words'), 'interview.txt')).toBe('txt');
    expect(detectTranscriptFormat(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]), 'x.txt')).toBe('docx');
  });

  it('refuses an old .doc and a .docx that is not a zip, with a sentence', () => {
    expect(() => detectTranscriptFormat(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1]), 'x.bin')).toThrow(/old-style \.doc/);
    expect(() => detectTranscriptFormat(buf('hello'), 'x.doc')).toThrow(TranscriptError);
    expect(() => detectTranscriptFormat(buf('hello'), 'x.docx')).toThrow(/not one/);
  });
});

describe('decodeText', () => {
  it('drops a UTF-8 BOM and reads both UTF-16 byte orders', () => {
    expect(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x41, 0x42]))).toBe('AB');
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Héllo', 'utf16le')]))).toBe('Héllo');
    const be = Buffer.from('Hé', 'utf16le'); be.swap16();
    expect(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe('Hé');
  });
});

describe('vttToText', () => {
  it('keeps the speaker, joins one speaker\'s consecutive cues and drops ids, timings, notes and tags', () => {
    expect(vttToText(VTT)).toBe([
      'Anna Voorbeeld: Yes, I am the owner of this application, but Piet does most of the day-to-day.',
      'Interviewer: Since when?',
      'Anna Voorbeeld: Since 2021.',
    ].join('\n'));
  });

  it('reads CRLF files and a cue without a voice tag', () => {
    expect(vttToText('WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\nPlain words\r\n')).toBe('Plain words');
  });
});

describe('srtToText', () => {
  it('drops index and timing lines and joins "Name: " cues of one speaker', () => {
    expect(srtToText(SRT)).toBe('Bram Test: I worked there early on as a junior.\nThen I left.');
  });
});

describe('documentXmlToText', () => {
  it('gives one line per paragraph, tabs as spaces, breaks as line breaks, entities decoded', () => {
    const xml = '<w:body><w:p><w:r><w:t>Owner</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve">&amp; more </w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>Line one</w:t><w:br/><w:t>Line two</w:t></w:r></w:p></w:body>';
    expect(documentXmlToText(xml)).toBe('Owner & more \nLine one\nLine two\n');
    expect(documentXmlToText('<w:p><w:t/><w:tab/><w:t>a</w:t><w:cr/><w:t>b</w:t></w:p>')).toBe(' a\nb\n');
  });

  it('decodes numeric and named entities, and leaves an unknown one as it was', () => {
    expect(decodeXmlEntities('&#233;&#xE9;&lt;&quot;&apos;&gt;&nbsp;')).toBe('éé<"\'>&nbsp;');
    expect(decodeXmlEntities('&#x110000;&#1114111;')).toBe('&#x110000;\u{10FFFF}');
  });
});

describe('tidyText', () => {
  it('trims line ends and collapses runs of blank lines to one', () => {
    expect(tidyText('  a  \r\n\r\n\r\n\r\nb\t\n')).toBe('a\n\nb');
  });
});

describe('parseTranscript', () => {
  it('reads each format to the same kind of text', async () => {
    expect(await parseTranscript(buf(VTT), { fileName: 'call.vtt' })).toEqual({ format: 'vtt', text: expect.stringMatching(/^Anna Voorbeeld: Yes/) });
    expect((await parseTranscript(buf(SRT), { fileName: 'call.srt' })).format).toBe('srt');
    expect(await parseTranscript(buf('﻿Hello\r\nthere'), { fileName: 'call.txt' })).toEqual({ format: 'txt', text: 'Hello\nthere' });
    const d = await parseTranscript(await docx('<w:p><w:t>Klant sinds 2019</w:t></w:p>'), { fileName: 'call.docx' });
    expect(d).toEqual({ format: 'docx', text: 'Klant sinds 2019' });
  });

  it('refuses an empty file, a transcript without words, and a zip that is not a Word document', async () => {
    await expect(parseTranscript(Buffer.alloc(0))).rejects.toThrow('The file is empty.');
    await expect(parseTranscript(buf(' \n\n '), { fileName: 'x.txt' })).rejects.toThrow('The transcript holds no text.');
    const zip = new JSZip(); zip.file('other.xml', '<a/>');
    await expect(parseTranscript(await zip.generateAsync({ type: 'nodebuffer' }), { fileName: 'x.docx' })).rejects.toThrow(/not a Word document/);
    await expect(parseTranscript(Buffer.from([0x50, 0x4b, 0x03, 0x04, 9, 9, 9]), { fileName: 'x.docx' })).rejects.toThrow(/could not be opened/);
  });

  it('accepts a transcript of exactly the cap and refuses one character more', async () => {
    const atCap = 'a'.repeat(MAX_TRANSCRIPT_CHARS);
    expect((await parseTranscript(buf(atCap), { fileName: 'x.txt' })).text.length).toBe(MAX_TRANSCRIPT_CHARS);
    await expect(parseTranscript(buf(`${atCap}b`), { fileName: 'x.txt' })).rejects.toThrow(/longer than 5,000,000 characters/);
  });
});
