// Context sources — the text of what an analyst adds to a unit's page (Add information).
//
//   readSourceText({ file, text }) → Promise<{ text, fileName, format }>
//   rowsToText({ columns, rows })  → string   (pure)
//
// Whatever is added becomes text the extraction reads like a transcript and every
// quote must stand in verbatim:
//
//   txt md docx vtt srt   transcript.js (parseTranscript), as before
//   csv xlsx              upload/parse.js (parseList, the list upload's reader): one
//                         line per row, "Header: value; Header: value", empty cells
//                         left out — so "Name: Ann Example; Role: Architect" reads
//                         like a sentence and a quote can be a row
//   pasted text           tidied the same way, stored under PASTED_TEXT_NAME
//
// The original file name stays on the source (ContextInterviews."fileName"); a
// refusal is a TranscriptError with a sentence for the analyst (the route answers 400).

import { parseList, ListParseError } from '../upload/parse.js';
import { parseTranscript, finishText, TranscriptError } from './transcript.js';
import { PASTED_TEXT_NAME } from './store.js';

export const LIST_FILE = /\.(csv|xlsx)$/i;

const filled = (v) => v !== null && v !== undefined && String(v).trim() !== '';

/** One readable line per row of a list: "Header: value; Header: value". Pure. */
export function rowsToText({ columns, rows }) {
  return rows
    .map(r => columns.filter(c => filled(r[c])).map(c => `${c}: ${String(r[c]).trim()}`).join('; '))
    .filter(Boolean)
    .join('\n');
}

async function listText(file) {
  try {
    return finishText(rowsToText(await parseList(file.buffer, { fileName: file.originalname })));
  } catch (err) {
    if (err instanceof ListParseError) throw new TranscriptError(err.message);
    throw err;
  }
}

/**
 * The text of an added source: an uploaded `file` (multer: { buffer, originalname })
 * or pasted `text`. A file wins when both are given.
 */
export async function readSourceText({ file = null, text = null } = {}) {
  if (file) {
    if (LIST_FILE.test(file.originalname)) return { text: await listText(file), fileName: file.originalname, format: 'list' };
    const read = await parseTranscript(file.buffer, { fileName: file.originalname });
    return { ...read, fileName: file.originalname };
  }
  if (typeof text !== 'string' || !text.trim()) throw new TranscriptError('Add a file or paste the text.');
  return { text: finishText(text), fileName: PASTED_TEXT_NAME, format: 'text' };
}
