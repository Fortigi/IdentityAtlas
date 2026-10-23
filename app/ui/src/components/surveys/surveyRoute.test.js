import { describe, it, expect } from 'vitest';
import { requestFromHash, surveyHash } from './surveyRoute';
import { parseJson, NEW_DEFINITION } from './templateEditor.helpers';

const ID = 'ffffffff-0000-4000-8000-000000000001';

describe('requestFromHash / surveyHash', () => {
  it('reads a uuid request from the hash, lower-cased; anything else is no request', () => {
    expect(requestFromHash(`#surveys?request=${ID.toUpperCase()}`)).toBe(ID);
    expect(requestFromHash(`#surveys?x=1&request=${ID}`)).toBe(ID);
    expect(requestFromHash('#surveys?request=not-a-uuid')).toBeNull();
    expect(requestFromHash('#surveys')).toBeNull();
    expect(requestFromHash(undefined)).toBeNull();
  });

  it('builds the hash back', () => {
    expect(surveyHash(ID)).toBe(`surveys?request=${ID}`);
    expect(surveyHash(null)).toBe('surveys');
  });
});

describe('templateEditor helpers', () => {
  it('parseJson gives the value or the parser\'s error; a new template starts from a definition', () => {
    expect(parseJson('{"a":1}')).toEqual({ value: { a: 1 } });
    expect(parseJson('{a:1}').error).toMatch(/JSON|property/i);
    expect(NEW_DEFINITION.sections[0].questions[0].answer.type).toBe('yesNo');
  });
});
