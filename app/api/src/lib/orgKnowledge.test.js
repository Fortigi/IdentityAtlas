import { describe, it, expect } from 'vitest';
import { KNOWLEDGE_KINDS, KNOWLEDGE, isKnowledgeKind, objectKey, kindOfContextType } from './orgKnowledge.js';

describe('orgKnowledge', () => {
  it('names the three kinds, their object types and the brief’s predicates', () => {
    expect(KNOWLEDGE_KINDS).toEqual(['activity', 'expertise', 'duty']);
    expect(KNOWLEDGE_KINDS.map(k => [KNOWLEDGE[k].contextType, KNOWLEDGE[k].predicate])).toEqual([
      ['Activity', 'performsActivity'], ['Expertise', 'hasExpertise'], ['Duty', 'holdsResponsibility'],
    ]);
    expect(isKnowledgeKind('duty')).toBe(true);
    expect(isKnowledgeKind('role')).toBe(false);
  });

  it('keys an object name case- and spacing-insensitively', () => {
    expect(objectKey('  Works   COUNCIL\tmember ')).toBe('works council member');
    expect(objectKey(null)).toBe('');
  });

  it('maps an object’s contextType back to its kind', () => {
    expect(['Activity', 'Expertise', 'Duty', 'Tag'].map(kindOfContextType)).toEqual(['activity', 'expertise', 'duty', null]);
  });
});
