// The relevance tier: fixed rules first, the model's own tier only where the rules are silent.
import { describe, it, expect } from 'vitest';
import { relevanceOf, withRelevance, namesAccessTerm } from './relevance.js';

const claim = (claimKind, over = {}) => ({ claimKind, value: 'x', attribute: null, relevance: null, ...over });

describe('relevanceOf', () => {
  it('people, membership and aliases are always high — even when the model said low', () => {
    for (const kind of ['role', 'roleHistory', 'membership', 'alias']) {
      expect(relevanceOf(claim(kind, { relevance: 'low' }))).toBe('high');
    }
  });

  it('a property that names something access depends on is high, whatever the model said', () => {
    expect(relevanceOf(claim('property', { attribute: 'sector', value: 'ports', relevance: 'low' }))).toBe('high');
    expect(relevanceOf(claim('property', { attribute: 'customerSince', value: '2019', relevance: 'low' }))).toBe('high');
    // The term in the value, not the attribute name.
    expect(relevanceOf(claim('property', { attribute: 'uses', value: 'the planning app', relevance: 'low' }))).toBe('high');
  });

  it('any other property follows the model, and without a model tier it is low', () => {
    expect(relevanceOf(claim('property', { attribute: 'canteen', value: 'very good soup', relevance: 'high' }))).toBe('high');
    expect(relevanceOf(claim('property', { attribute: 'canteen', value: 'very good soup', relevance: 'low' }))).toBe('low');
    expect(relevanceOf(claim('property', { attribute: 'canteen', value: 'very good soup' }))).toBe('low');
    expect(relevanceOf(claim('property', { attribute: 'canteen', value: 'very good soup', relevance: 'medium' }))).toBe('low');
  });

  it('a description follows the model; without one it is high only when it names an access term', () => {
    expect(relevanceOf(claim('description', { value: 'Runs the harbour systems', relevance: 'low' }))).toBe('low');
    expect(relevanceOf(claim('description', { value: 'The weather is usually grey', relevance: 'high' }))).toBe('high');
    expect(relevanceOf(claim('description', { value: 'Runs the harbour systems' }))).toBe('high');
    expect(relevanceOf(claim('description', { value: 'The weather is usually grey' }))).toBe('low');
  });
});

describe('namesAccessTerm', () => {
  it('matches a stem at the start of a word, in any case', () => {
    expect(namesAccessTerm('Regulated by the port authority')).toBe(true);
    expect(namesAccessTerm('mainContractor')).toBe(true);
    expect(namesAccessTerm('customerSince')).toBe(true);
    // Inside a word is not the start of one.
    expect(namesAccessTerm('unregulated')).toBe(false);
  });

  it('matches a short word only whole', () => {
    expect(namesAccessTerm('they use one app for it')).toBe(true);
    expect(namesAccessTerm('Data, mostly')).toBe(true);
    expect(namesAccessTerm('we appreciate the approach')).toBe(false);
    expect(namesAccessTerm('a database person')).toBe(false);
    expect(namesAccessTerm(null)).toBe(false);
  });
});

describe('withRelevance', () => {
  it('sets the tier on new objects and leaves the input alone', () => {
    const input = [claim('role'), claim('description', { value: 'nice people' })];
    const out = withRelevance(input);
    expect(out.map(c => c.relevance)).toEqual(['high', 'low']);
    expect(input.map(c => c.relevance)).toEqual([null, null]);
  });
});
