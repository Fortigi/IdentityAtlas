import { describe, it, expect } from 'vitest';
import { readCappedBody } from './cappedBody.js';

// A Response whose body arrives in the given chunks, with no Content-Length
// header — the case where only the streaming count can enforce the cap.
function streamed(chunks) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body);
}

describe('readCappedBody', () => {
  it('returns the whole body when it is exactly at the cap', async () => {
    expect(await readCappedBody(streamed(['abc', 'de']), 5)).toBe('abcde');
  });

  it('refuses a streamed body one byte over the cap, naming the label', async () => {
    await expect(readCappedBody(streamed(['abc', 'def']), 5, 'Feed')).rejects.toThrow(/^Feed exceeded 5-byte cap$/);
  });

  it('refuses up front when the declared Content-Length is over the cap', async () => {
    const resp = new Response('x', { headers: { 'content-length': '6' } });
    await expect(readCappedBody(resp, 5)).rejects.toThrow('Response too large (6 bytes > 5-byte cap)');
  });

  it('accepts a declared Content-Length exactly at the cap', async () => {
    const resp = new Response('abcde', { headers: { 'content-length': '5' } });
    expect(await readCappedBody(resp, 5)).toBe('abcde');
  });

  it('cancels the upstream stream when it abandons an over-cap body', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(4)); },
      cancel() { cancelled = true; },
    });
    await expect(readCappedBody(new Response(body), 10)).rejects.toThrow(/exceeded 10-byte cap/);
    expect(cancelled).toBe(true);
  });

  it('falls back to text() for a body-less response object', async () => {
    expect(await readCappedBody({ headers: new Headers(), text: async () => 'plain' }, 1)).toBe('plain');
  });
});
