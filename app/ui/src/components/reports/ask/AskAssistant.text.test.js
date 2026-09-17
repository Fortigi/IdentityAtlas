// The words around the question box — what this pins down:
//   • each warm-up state has its own status line, and the two long waits say
//     how long they usually take; a ready or idle model says nothing
//   • the unavailable reason names the missing model only when that is the reason
//   • answering a clarifying question wins over changing the current definition
//   • the timing line reports the numbers it was given, not rounded-away ones
import { describe, it, expect } from 'vitest';
import { formatTiming, questionPrompt, unavailableReason, warmStatusText } from './AskAssistant.text';

describe('warmStatusText', () => {
  it('counts the seconds while loading, and tells the two long waits apart', () => {
    expect(warmStatusText('warming', 7)).toBe('loading the model… 7s');
    expect(warmStatusText('starting', 13)).toBe('loading the model into memory — usually under a minute… 13s');
    expect(warmStatusText('preparing', 42)).toBe('the model is preparing its prompt cache (first time after an update) — questions work but are slow… 42s');
  });

  it('says the server did not respond, without a counter, on error', () => {
    expect(warmStatusText('error', 99)).toBe('model server did not respond');
  });

  it('says nothing once the model is ready, or before warming started', () => {
    expect(warmStatusText('ready', 5)).toBe('');
    expect(warmStatusText('idle', 5)).toBe('');
  });
});

describe('unavailableReason', () => {
  it('names the model when it is not installed', () => {
    expect(unavailableReason({ reason: 'model-not-installed', model: 'llama-x:13b' })).toBe('model "llama-x:13b" is not installed');
  });

  it('blames the server for any other reason, or no status at all', () => {
    expect(unavailableReason({ reason: 'server-unreachable', model: 'llama-x:13b' })).toBe('the local model server is not reachable');
    expect(unavailableReason(undefined)).toBe('the local model server is not reachable');
  });
});

describe('questionPrompt', () => {
  it('asks for an answer while a clarifying question is open, even with a definition in the builder', () => {
    expect(questionPrompt({ awaitingAnswer: true, currentSpec: { entity: 'user' } }))
      .toEqual({ label: 'Your answer', placeholder: 'Or type your own answer…' });
  });

  it('asks for a change when there is a definition, and for a new report otherwise', () => {
    expect(questionPrompt({ awaitingAnswer: false, currentSpec: { entity: 'user' } }).label).toBe('Describe a change to the report');
    expect(questionPrompt({ awaitingAnswer: false, currentSpec: null }).label).toBe('Describe the report you want');
  });
});

describe('formatTiming', () => {
  it('is empty when the reply carries no timing', () => {
    expect(formatTiming(null)).toBe('');
  });

  it('shows each duration in seconds with one decimal, next to its token count', () => {
    expect(formatTiming({ totalMs: 12340, promptMs: 870, outputMs: 11470, promptTokens: 3001, outputTokens: 257 }))
      .toBe('12.3s · read 3001 tokens in 0.9s · wrote 257 tokens in 11.5s');
  });
});
