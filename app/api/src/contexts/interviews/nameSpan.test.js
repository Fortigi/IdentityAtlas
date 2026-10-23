// The full name a verbatim quote gives for a name the model cut short.
import { describe, it, expect } from 'vitest';
import { nameSpansIn } from './nameSpan.js';

describe('nameSpansIn', () => {
  it('finds the full name around a surname, across particles', () => {
    expect(nameSpansIn('Vries', 'Piet de Vries does most of the day-to-day work there')).toEqual(['Piet de Vries']);
    expect(nameSpansIn('de Vries', 'and then Piet de Vries took it over')).toEqual(['Piet de Vries']);
    expect(nameSpansIn('Hilderink', 'Led Hilderink does most of the day-to-day work there')).toEqual(['Led Hilderink']);
    expect(nameSpansIn('Berg', 'ask Jan van der Berg about it')).toEqual(['Jan van der Berg']);
  });

  it('lists every longer span, longest first, so a sentence-start word does not hide the name', () => {
    expect(nameSpansIn('Vries', 'So Piet de Vries runs it')).toEqual(['So Piet de Vries', 'Piet de Vries']);
  });

  it('reads a possessive as the name, and a subject in any case or with punctuation', () => {
    expect(nameSpansIn("Hilderink's", "it is Led Hilderink's job")).toEqual(['Led Hilderink']);
    expect(nameSpansIn('VRIES,', 'Piet de Vries does it')).toEqual(['Piet de Vries']);
  });

  it('a comma or full stop ends a name; lowercase words that are not particles are not part of one', () => {
    expect(nameSpansIn('Vries', 'Thanks, Vries. Piet runs it')).toEqual([]);
    expect(nameSpansIn('Vries', 'Piet and Vries run it')).toEqual([]);
  });

  it('only spans with 2 to 4 capitalised words, longer than the subject, that contain it', () => {
    expect(nameSpansIn('Piet de Vries', 'Piet de Vries runs it')).toEqual([]);
    expect(nameSpansIn('Vries', 'Vries runs it')).toEqual([]);
    expect(nameSpansIn('Jansen', 'Piet de Vries runs it')).toEqual([]);
    expect(nameSpansIn('Vries', 'The Big Old Main Office Vries team')).toEqual(['Old Main Office Vries', 'Main Office Vries', 'Office Vries']);
  });

  it('nothing for an empty subject or quote', () => {
    expect(nameSpansIn('', 'Piet de Vries')).toEqual([]);
    expect(nameSpansIn('Vries', null)).toEqual([]);
  });
});
