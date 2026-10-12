// Organisation knowledge extraction — a transcript upload, checked and prepared.
//
//   readTranscriptRequest({ body, file }) → { error } | { buffer, fileName, mimeType, fields }
//   prepareTranscript({ buffer, fileName, fields }) → { error } | { text, format, passages, sha256, metadata }
//
// Accepted: a file (.txt, .md, .srt, .vtt) in the multipart field "file", or the
// text itself in the JSON/form field "text" (pasted, or a Teams/Copilot transcript
// copied out). Stored as given; the same bytes uploaded twice are the same source.
import { CLASSIFICATIONS, SOURCE_FORMATS, MAX_SOURCE_CHARS } from './contracts.js';
import { detectFormat, canonicalize, segment, guessLanguage, sha256 } from './segment.js';

export const SOURCE_TYPES = Object.freeze(['interview', 'meeting', 'note', 'other']);
const EXTENSIONS = /\.(txt|md|markdown|srt|vtt)$/i;

const trimmed = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// "nl" or "nl-NL": two lowercase letters, optionally a dash and two uppercase ones.
export function isLanguageTag(tag) {
  const [lang, region, ...rest] = tag.split('-');
  if (rest.length || !/^[a-z]{2}$/.test(lang)) return false;
  return region === undefined || /^[A-Z]{2}$/.test(region);
}

// The transcript itself: an uploaded file, or pasted text.
function readContent(b, file) {
  if (file) {
    if (!EXTENSIONS.test(file.originalname ?? '')) return { error: 'Upload a .txt, .md, .srt or .vtt transcript, or paste the text.' };
    return { buffer: file.buffer, fileName: file.originalname, mimeType: file.mimetype || 'text/plain' };
  }
  if (typeof b.text === 'string' && b.text.trim()) {
    return { buffer: Buffer.from(b.text, 'utf8'), fileName: trimmed(b.fileName) || 'pasted-transcript.txt', mimeType: 'text/plain' };
  }
  return { error: 'No transcript: upload a file in the field "file" or send the text in the field "text".' };
}

export function readTranscriptRequest({ body, file }) {
  const b = body ?? {};
  const content = readContent(b, file);
  if (content.error) return content;
  const fields = readFields(b, content.fileName);
  return fields.error ? fields : { ...content, fields };
}

function readFields(b, fileName) {
  const observedAt = b.observedAt ? new Date(b.observedAt) : new Date();
  if (Number.isNaN(observedAt.getTime())) return { error: `observedAt "${b.observedAt}" is not a date; use ISO 8601, for example 2026-10-11.` };
  const classification = b.classification || 'internal';
  if (!CLASSIFICATIONS.includes(classification)) return { error: `classification must be one of ${CLASSIFICATIONS.join(', ')}.` };
  const sourceType = b.sourceType || 'interview';
  if (!SOURCE_TYPES.includes(sourceType)) return { error: `sourceType must be one of ${SOURCE_TYPES.join(', ')}.` };
  const language = trimmed(b.language, 10) || null;
  if (language && !isLanguageTag(language)) return { error: 'language must look like "nl" or "nl-NL".' };
  return {
    displayName: trimmed(b.displayName) || fileName,
    observedAt: observedAt.toISOString(),
    speaker: trimmed(b.speaker, 120) || null,
    language, classification, sourceType,
    note: trimmed(b.note, 1000) || null,
  };
}

export function prepareTranscript({ buffer, fileName, fields }) {
  let raw;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return { error: 'The transcript is not valid UTF-8 text.' };
  }
  if (raw.includes('\u0000')) return { error: 'The transcript contains binary data; upload plain text.' };
  const format = detectFormat(fileName, raw);
  if (!SOURCE_FORMATS.includes(format)) return { error: `Unsupported transcript format ${format}.` };
  const { text, cues } = canonicalize(raw, format);
  if (!text.trim()) return { error: 'The transcript is empty.' };
  if (text.length > MAX_SOURCE_CHARS) return { error: `The transcript is longer than ${MAX_SOURCE_CHARS} characters; split it first.` };
  const passages = segment(text, cues);
  const language = fields.language ?? guessLanguage(text);
  return {
    text, format, passages, sha256: sha256(buffer),
    metadata: {
      format, language, languageGuessed: !fields.language, speaker: fields.speaker, classification: fields.classification,
      sourceType: fields.sourceType, note: fields.note, passageCount: passages.length,
    },
  };
}
