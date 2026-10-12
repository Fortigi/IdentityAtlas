// Organisation knowledge extraction — stage 0: a transcript becomes canonical text
// plus numbered passages. Pure and deterministic: the same bytes always give the
// same text, the same passages and the same offsets.
//
//   detectFormat(fileName, text)      → 'srt' | 'vtt' | 'markdown' | 'text'
//   canonicalize(raw, format)         → { text, cues }   cues only for srt/vtt
//   segment(text, cues?)              → [{ seq, startChar, endChar, text, speaker, startMs, endMs }]
//   guessLanguage(text)               → 'nl' | 'en' | null
//   sha256(bufferOrString)            → hex
//
// The canonical text is what every offset refers to (OrgSources.textContent). For
// plain text and markdown it IS the upload (line endings normalised, BOM dropped);
// for subtitles it is the cue texts joined by newlines, with the cue times kept on
// the passages. The original bytes are stored next to it, unchanged.
import { createHash } from 'node:crypto';

export const MAX_PASSAGE_CHARS = 450;

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const SRT_TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
const SRT_CUE = /^\s*\d+\s*\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/m;

export function detectFormat(fileName, text) {
  const name = String(fileName ?? '').toLowerCase();
  const body = String(text ?? '').replace(/^﻿/, '');
  if (name.endsWith('.vtt') || /^WEBVTT/.test(body)) return 'vtt';
  if (name.endsWith('.srt') || SRT_CUE.test(body)) return 'srt';
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'markdown';
  return 'text';
}

function toMs(stamp) {
  const m = SRT_TIME.exec(stamp) ?? /(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(stamp);
  if (!m) return null;
  if (m.length === 5) return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4].padEnd(3, '0');
  return (+m[1] * 60 + +m[2]) * 1000 + +m[3].padEnd(3, '0');
}

// "<v Wim>tekst</v>" or "Wim: tekst" — the speaker, and the text without the tag.
function speakerOf(line) {
  if (line.startsWith('<v') && line.indexOf('>') > 2) {
    const close = line.indexOf('>');
    const head = line.slice(2, close);                  // ".loud Wim" or " Wim"
    const name = head.slice(head.indexOf(' ') + 1).trim();
    if (/^[.\s]/.test(head) && name) return { speaker: name, text: line.slice(close + 1).replace(/<\/v>/g, '').trim() };
  }
  return { speaker: null, text: stripTags(line).trim() };
}

// Cue markup (<i>, <c.colour>, <00:01.000>) removed until none is left, so a tag
// rebuilt from the pieces of another ("<<i>i>") cannot survive one pass.
export function stripTags(text) {
  let out = String(text);
  let prev;
  do {
    prev = out;
    out = out.replace(/<[^<>]*>/g, '');
  } while (out !== prev);
  return out.replace(/[<>]/g, '');
}

function parseCues(body) {
  const blocks = body.split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const timeAt = lines.findIndex(l => l.includes('-->'));
    if (timeAt < 0) continue;
    const [from, to] = lines[timeAt].split('-->').map(s => s.trim());
    const words = lines.slice(timeAt + 1).join(' ').trim();
    if (!words) continue;
    const { speaker, text } = speakerOf(words);
    if (text) cues.push({ startMs: toMs(from), endMs: toMs(to), speaker, text });
  }
  return cues;
}

/** @returns {{ text: string, cues: Array|null }} */
export function canonicalize(raw, format) {
  const body = String(raw ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (format !== 'srt' && format !== 'vtt') return { text: body, cues: null };
  const parsed = parseCues(body);
  let text = '';
  const cues = parsed.map((c) => {
    const line = c.speaker ? `${c.speaker}: ${c.text}` : c.text;
    const startChar = text.length;
    text += (text ? '\n' : '') + line;
    return { ...c, startChar: startChar === 0 ? 0 : startChar + 1, endChar: text.length };
  });
  return { text, cues };
}

// Sentence ends: . ! ? … followed by whitespace, or a newline.
const SENTENCE_END = /[.!?…]+["'’”)]*(?=\s)|\n/g;

function sentences(text, from, to) {
  const out = [];
  let start = from;
  SENTENCE_END.lastIndex = from;
  let m;
  while ((m = SENTENCE_END.exec(text)) !== null && m.index < to) {
    const end = m.index + m[0].length;
    pushTrimmed(out, text, start, Math.min(end, to));
    start = end;
  }
  pushTrimmed(out, text, start, to);
  return out;
}

function pushTrimmed(out, text, start, end) {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) s += 1;
  while (e > s && /\s/.test(text[e - 1])) e -= 1;
  if (e > s) out.push([s, e]);
}

// A sentence longer than the limit is cut at the last space before it.
function capped([s, e], text) {
  const out = [];
  let start = s;
  while (e - start > MAX_PASSAGE_CHARS) {
    const window = text.slice(start, start + MAX_PASSAGE_CHARS);
    const cut = window.lastIndexOf(' ');
    const end = start + (cut > MAX_PASSAGE_CHARS / 2 ? cut : MAX_PASSAGE_CHARS);
    pushTrimmed(out, text, start, end);
    start = end;
  }
  pushTrimmed(out, text, start, e);
  return out;
}

const PARAGRAPH_SPEAKER = /^([A-ZÀ-Ý][\p{L}.' -]{0,30}):\s/u;

function paragraphs(text) {
  const out = [];
  const re = /\n\s*\n/g;
  let start = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push([start, m.index]);
    start = m.index + m[0].length;
  }
  out.push([start, text.length]);
  return out;
}

// Greedy packing of sentence ranges into passages of at most MAX_PASSAGE_CHARS.
function pack(ranges) {
  const groups = [];
  let cur = null;
  for (const [s, e] of ranges) {
    if (cur && e - cur[0] <= MAX_PASSAGE_CHARS) cur[1] = e;
    else {
      cur = [s, e];
      groups.push(cur);
    }
  }
  return groups;
}

function textPassages(text) {
  const out = [];
  for (const [ps, pe] of paragraphs(text)) {
    const para = text.slice(ps, pe);
    const speaker = PARAGRAPH_SPEAKER.exec(para.trimStart())?.[1] ?? null;
    const ranges = sentences(text, ps, pe).flatMap(r => capped(r, text));
    for (const [s, e] of pack(ranges)) out.push({ startChar: s, endChar: e, speaker, startMs: null, endMs: null });
  }
  return out;
}

function cuePassages(text, cues) {
  const out = [];
  let cur = null;
  for (const c of cues) {
    const fits = cur && c.endChar - cur.startChar <= MAX_PASSAGE_CHARS && cur.speaker === c.speaker;
    if (fits) {
      cur.endChar = c.endChar;
      cur.endMs = c.endMs;
    } else {
      cur = { startChar: c.startChar, endChar: c.endChar, speaker: c.speaker, startMs: c.startMs, endMs: c.endMs };
      out.push(cur);
    }
  }
  return out.flatMap(p => (p.endChar - p.startChar > MAX_PASSAGE_CHARS
    ? capped([p.startChar, p.endChar], text).map(([s, e]) => ({ ...p, startChar: s, endChar: e }))
    : [p]));
}

export function segment(text, cues = null) {
  const raw = cues?.length ? cuePassages(text, cues) : textPassages(text);
  return raw.map((p, i) => ({ seq: i + 1, ...p, text: text.slice(p.startChar, p.endChar) }));
}

const NL = new Set(['de', 'het', 'een', 'en', 'van', 'is', 'dat', 'niet', 'wij', 'zijn', 'er', 'ook', 'maar', 'bij', 'voor', 'met', 'die', 'dit', 'ik', 'je']);
const EN = new Set(['the', 'and', 'is', 'of', 'to', 'we', 'that', 'not', 'are', 'with', 'for', 'this', 'it', 'you', 'i', 'have', 'but', 'they']);

export function guessLanguage(text) {
  const words = String(text ?? '').toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  let nl = 0;
  let en = 0;
  for (const w of words) {
    if (NL.has(w)) nl += 1;
    if (EN.has(w)) en += 1;
  }
  if (nl + en < 5) return null;
  if (nl >= en * 1.5) return 'nl';
  if (en >= nl * 1.5) return 'en';
  return null;
}
