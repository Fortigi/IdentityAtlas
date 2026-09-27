// Streaming delimited-file writer. Rows are buffered into ~1 MB chunks and
// written with backpressure, so memory stays flat whatever the file size — the
// assignments file at full scale is ~2 GB and is never held in memory.

import fs from 'node:fs';
import { once } from 'node:events';

export const DELIMITERS = Object.freeze({ tab: '\t', comma: ',', semicolon: ';', pipe: '|' });

// `tab` / `comma` / `semicolon` / `pipe`, a literal single character, or `\t`.
export function resolveDelimiter(value) {
  if (value === undefined || value === null || value === '') return DELIMITERS.tab;
  if (DELIMITERS[value]) return DELIMITERS[value];
  if (value === '\\t') return '\t';
  if (value.length === 1 && value !== '"' && value !== '\n' && value !== '\r') return value;
  throw new Error(`Unsupported delimiter ${JSON.stringify(value)} — use tab, comma, semicolon, pipe or one character`);
}

// RFC 4180: quote a field only when it contains the delimiter, a quote or a line
// break, doubling embedded quotes. Correct CSV — which is exactly what the
// crawler's fast path cannot read when the delimiter is inside a value.
export function formatField(value, delimiter) {
  const s = value === null || value === undefined ? '' : String(value);
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function formatRow(values, delimiter) {
  let line = '';
  for (let i = 0; i < values.length; i++) {
    if (i > 0) line += delimiter;
    line += formatField(values[i], delimiter);
  }
  return `${line}\n`;
}

const CHUNK = 1 << 20;

export class CsvWriter {
  constructor(path, header, { delimiter = '\t', bom = true } = {}) {
    this.path = path;
    this.delimiter = delimiter;
    this.rows = 0;
    this.bytes = 0;
    // header null: a headerless file (the IdentityIQ fixture's bcp records).
    this.buffer = (bom ? '﻿' : '') + (header ? formatRow(header, delimiter) : '');
    this.stream = fs.createWriteStream(path, { encoding: 'utf8', highWaterMark: 4 * CHUNK });
    this.failed = null;
    this.stream.on('error', (err) => { this.failed = err; });
  }

  // Buffer an already-formatted line. Synchronous so the 40M-row loop does not pay
  // an await per row; returns true when the caller should `await flush()`.
  append(line) {
    this.buffer += line;
    this.rows++;
    return this.buffer.length >= CHUNK;
  }

  async writeLine(line) {
    if (this.append(line)) await this.flush();
  }

  async writeRow(values) {
    await this.writeLine(formatRow(values, this.delimiter));
  }

  async flush() {
    if (this.failed) throw this.failed;
    if (this.buffer.length === 0) return;
    const chunk = this.buffer;
    this.buffer = '';
    this.bytes += Buffer.byteLength(chunk, 'utf8');
    // events.once rejects on 'error' and removes both listeners either way.
    if (!this.stream.write(chunk)) await once(this.stream, 'drain');
  }

  async close() {
    await this.flush();
    await new Promise((resolve, reject) => {
      this.stream.end((err) => (err ? reject(err) : resolve()));
    });
    if (this.failed) throw this.failed;
    return { path: this.path, rows: this.rows, bytes: this.bytes };
  }
}
