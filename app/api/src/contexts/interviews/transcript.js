// Context interviews — read an uploaded transcript (txt, docx, vtt, srt) into plain text.
//
//   parseTranscript(buffer, { fileName }) → Promise<{ text, format }>
//
// The text is what the model reads and what every quote must be a verbatim part
// of, so it is kept close to what was said: one line per turn, "Speaker: words"
// where the file names the speaker.
//
//   txt   UTF-8 (with or without a BOM) or UTF-16 with a BOM; line breaks normalised.
//   docx  the paragraphs of word/document.xml (jszip, already an API dependency),
//         one per line; tabs and breaks kept as a space and a line break.
//   vtt   WebVTT: the header, NOTE / STYLE / REGION blocks, cue ids and timings
//         dropped; a voice tag <v Name> becomes "Name: "; consecutive cues of one
//         speaker are joined into one turn (a quote may span them).
//   srt   SubRip: index and timing lines dropped; consecutive cues joined the same way.
//
// Every refusal throws a TranscriptError whose message is a sentence for the
// person who uploaded the file (the route answers 400 with it).

import JSZip from 'jszip';

// A long interview is ~100 kB of text; this bounds what one row may hold.
export const MAX_TRANSCRIPT_CHARS = 5_000_000;

export class TranscriptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TranscriptError';
  }
}

const isZip = (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const isOle = (b) => b.length >= 4 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
// A cue timing line: "00:00:01.000 --> 00:00:04.000" (vtt) or with commas (srt).
const TIMING = /^\s*\d[\d:.,]{3,12}\s{1,5}-->\s{1,5}\d[\d:.,]{3,12}/;

/** 'docx' | 'vtt' | 'srt' | 'txt' for an uploaded file; refuses an old .doc. */
export function detectTranscriptFormat(buffer, fileName = '') {
  if (isOle(buffer) || /\.doc$/i.test(fileName)) {
    throw new TranscriptError('This is an old-style .doc file; save it as .docx or .txt and upload it again.');
  }
  if (isZip(buffer)) return 'docx';
  if (/\.docx$/i.test(fileName)) throw new TranscriptError('The file is named as a Word document but is not one; save it again as .docx or .txt.');
  const head = decodeText(buffer.subarray(0, 4096)).trimStart();
  if (/^WEBVTT/.test(head)) return 'vtt';
  if (/\.srt$/i.test(fileName) || /^\d+\s*\n[^\n]*-->/.test(head)) return 'srt';
  return 'txt';
}

/** Bytes → string: UTF-16 when a BOM says so, else UTF-8 (BOM dropped). */
export function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buffer.toString('utf8').replace(/^﻿/, '');
}

const normaliseLines = (text) => text.replace(/\r\n?/g, '\n');

// ─── docx ────────────────────────────────────────────────────────────────
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const HEX_REF = /^#x[0-9a-f]+$/i;
const DEC_REF = /^#\d+$/;

function entityValue(whole, name) {
  let code = null;
  if (HEX_REF.test(name)) code = parseInt(name.slice(2), 16);
  else if (DEC_REF.test(name)) code = parseInt(name.slice(1), 10);
  if (code !== null) return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  return ENTITIES[name.toLowerCase()] ?? whole;
}

export function decodeXmlEntities(s) {
  return s.replace(/&([#a-z0-9]{1,10});/gi, entityValue);
}

// A text run (its text holds no '<': XML escapes it), a tab, or a break.
const RUN_PART = /<w:t\b[^>]*>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g;
const RUN_SEPARATOR = { '<w:tab/>': ' ', '<w:br/>': '\n', '<w:cr/>': '\n' };

/** The text of word/document.xml: one line per paragraph. Pure. */
export function documentXmlToText(xml) {
  return xml.split(/<\/w:p>/)
    .map(p => [...p.matchAll(RUN_PART)].map(m => (m[1] !== undefined ? decodeXmlEntities(m[1]) : RUN_SEPARATOR[m[0]])).join(''))
    .join('\n');
}

async function readDocx(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new TranscriptError('The Word document could not be opened; save it again as .docx or .txt.');
  }
  const doc = zip.file('word/document.xml');
  if (!doc) throw new TranscriptError('The file is a zip archive but not a Word document; upload a .docx, .txt, .vtt or .srt file.');
  return documentXmlToText(await doc.async('string'));
}

// ─── vtt / srt ───────────────────────────────────────────────────────────
// Cue markup removed until none is left: one pass over "<<b>i>" would leave "<i>".
// A tag never spans a "<", so each pass is linear.
function dropTags(s) {
  let out = s;
  for (let prev = null; prev !== out;) {
    prev = out;
    out = out.replace(/<[^<>]*>/g, '');
  }
  return out;
}

// One cue's text: a voice tag names its speaker; every other tag is dropped.
function cueTurn(lines) {
  const joined = lines.join(' ').trim();
  const voice = /^<v[^\s>]*\s+([^\s>][^>]*)>/.exec(joined);
  const words = dropTags(joined).replace(/\s+/g, ' ').trim();
  if (voice) return { speaker: voice[1].trim(), words };
  const named = /^([^:]{1,60}):\s+(.*)$/.exec(words);
  return named ? { speaker: named[1].trim(), words: named[2] } : { speaker: null, words };
}

// Consecutive turns of one speaker become one line.
function joinTurns(turns) {
  const out = [];
  for (const t of turns) {
    if (!t.words) continue;
    const last = out[out.length - 1];
    if (last && last.speaker === t.speaker) last.words = `${last.words} ${t.words}`;
    else out.push({ ...t });
  }
  return out.map(t => (t.speaker ? `${t.speaker}: ${t.words}` : t.words)).join('\n');
}

const SKIPPED_VTT_BLOCK = /^(?:WEBVTT|NOTE|STYLE|REGION)\b/;

/** WebVTT → turns text. Pure. */
export function vttToText(text) {
  const turns = [];
  for (const block of normaliseLines(text).split(/\n{2,}/)) {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    if (lines.length === 0 || SKIPPED_VTT_BLOCK.test(lines[0])) continue;
    const timingAt = lines.findIndex(l => TIMING.test(l));
    if (timingAt < 0) continue;
    turns.push(cueTurn(lines.slice(timingAt + 1)));
  }
  return joinTurns(turns);
}

/** SubRip → turns text. Pure. */
export function srtToText(text) {
  const turns = [];
  for (const block of normaliseLines(text).split(/\n{2,}/)) {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    const timingAt = lines.findIndex(l => TIMING.test(l));
    if (timingAt < 0) continue;
    turns.push(cueTurn(lines.slice(timingAt + 1)));
  }
  return joinTurns(turns);
}

/** Plain text: line breaks normalised, trailing spaces and runs of blank lines dropped. */
export function tidyText(text) {
  return normaliseLines(text).split('\n').map(l => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function parseTranscript(buffer, { fileName = '' } = {}) {
  if (!buffer || buffer.length === 0) throw new TranscriptError('The file is empty.');
  const format = detectTranscriptFormat(buffer, fileName);
  let raw;
  if (format === 'docx') raw = await readDocx(buffer);
  else if (format === 'vtt') raw = vttToText(decodeText(buffer));
  else if (format === 'srt') raw = srtToText(decodeText(buffer));
  else raw = decodeText(buffer);
  const text = tidyText(raw);
  if (!text) throw new TranscriptError('The transcript holds no text.');
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    throw new TranscriptError(`The transcript is longer than ${MAX_TRANSCRIPT_CHARS.toLocaleString('en')} characters; split it and upload the parts.`);
  }
  return { text, format };
}
