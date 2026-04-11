// Tests for the risk prompt builders and JSON extractor.
//
// The prompt builders are pure functions of their inputs, so we just snapshot
// the structural shape (system + messages array) and assert key elements are
// present. The JSON extractor is the highest-value piece because LLMs love
// wrapping responses in markdown fences and we need to be tolerant of that.

import { describe, it, expect } from 'vitest';
import {
  profileGenerationPrompt,
  profileRefinementPrompt,
  classifierGenerationPrompt,
  extractJson,
} from './riskPrompts.js';

describe('profileGenerationPrompt', () => {
  it('includes the domain in the user message', () => {
    const { system, messages } = profileGenerationPrompt({ domain: 'example.com' });
    expect(system).toMatch(/identity security consultant/i);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toContain('example.com');
  });

  it('includes optional org name and hints when provided', () => {
    const { messages } = profileGenerationPrompt({
      domain: 'acme.com',
      organizationName: 'Acme Corp',
      hints: 'medical-device division only',
    });
    expect(messages[0].content).toContain('Acme Corp');
    expect(messages[0].content).toContain('medical-device');
  });

  it('embeds scraped context when supplied', () => {
    const { messages } = profileGenerationPrompt({
      domain: 'x.com',
      scrapedContext: '--- SOURCE: https://wiki ---\nrelevant text here',
    });
    expect(messages[0].content).toContain('relevant text here');
  });
});

describe('profileRefinementPrompt', () => {
  it('serialises the current profile in the system message', () => {
    const profile = { name: 'Foo', industry: 'logistics' };
    const { system, messages } = profileRefinementPrompt({
      currentProfile: profile,
      transcript: [],
      userMessage: 'add NIS2',
    });
    expect(system).toContain('"name": "Foo"');
    expect(messages[messages.length - 1].content).toBe('add NIS2');
  });

  it('replays prior user/assistant turns', () => {
    const { messages } = profileRefinementPrompt({
      currentProfile: {},
      transcript: [
        { role: 'user', content: 'first thing' },
        { role: 'assistant', content: '[updated profile applied]' },
      ],
      userMessage: 'second thing',
    });
    expect(messages.length).toBe(3); // 2 history + 1 new
    expect(messages[0].content).toBe('first thing');
    expect(messages[2].content).toBe('second thing');
  });
});

describe('classifierGenerationPrompt', () => {
  it('embeds the profile JSON in the user message', () => {
    const { system, messages } = classifierGenerationPrompt({ profile: { industry: 'banking' } });
    expect(system).toMatch(/regex.based risk classifiers/i);
    expect(messages[0].content).toContain('"industry": "banking"');
  });
});

describe('extractJson', () => {
  it('parses bare JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('strips ```json fences', () => {
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });
  it('strips ``` fences without language tag', () => {
    expect(extractJson('```\n{"a":3}\n```')).toEqual({ a: 3 });
  });
  it('handles leading prose', () => {
    expect(extractJson('Sure! Here you go:\n{"x": "y"}')).toEqual({ x: 'y' });
  });
  it('handles trailing prose', () => {
    expect(extractJson('{"x": "y"}\n\nLet me know if you need changes.')).toEqual({ x: 'y' });
  });
  it('returns null when nothing is parseable', () => {
    expect(extractJson('definitely not json at all')).toBeNull();
    expect(extractJson('')).toBeNull();
    expect(extractJson(null)).toBeNull();
  });
  it('handles nested objects', () => {
    const obj = { a: { b: { c: [1, 2, 3] } } };
    expect(extractJson(`prefix\n${JSON.stringify(obj)}\nsuffix`)).toEqual(obj);
  });
});
