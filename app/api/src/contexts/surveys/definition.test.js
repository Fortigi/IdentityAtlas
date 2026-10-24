// What a survey definition may say. Each case breaks exactly one rule of an
// otherwise valid definition, so a passing check proves that rule is enforced.
import { describe, it, expect } from 'vitest';
import { checkDefinition, questionsOf, textIn, fill, answerValues, LIMITS } from './definition.js';
import { SEED_TEMPLATES } from './seedTemplates.js';

const q = (over = {}) => ({ id: 'q1', text: 'Is it active?', answer: { type: 'yesNo' }, ...over });
const def = (questions, over = {}) => ({ schemaVersion: 1, languages: ['en'], title: 'T', sections: [{ id: 's', questions }], ...over });
const messages = (d) => checkDefinition(d).map(e => `${e.path}: ${e.message}`);

describe('checkDefinition — the frame', () => {
  it('accepts a minimal definition and every seed template', () => {
    expect(checkDefinition(def([q()]))).toEqual([]);
    for (const t of SEED_TEMPLATES) expect(checkDefinition(t.definition), t.key).toEqual([]);
  });

  it('refuses what is not an object, a wrong schemaVersion and bad languages', () => {
    expect(messages(null)).toEqual([': a definition is a JSON object']);
    expect(messages([q()])).toEqual([': a definition is a JSON object']);
    expect(messages(def([q()], { schemaVersion: 2 }))).toEqual(['schemaVersion: must be 1']);
    expect(messages(def([q()], { languages: [] }))[0]).toMatch(/^languages: name at least one/);
    expect(messages(def([q()], { languages: ['EN'] }))).toEqual(['languages: EN is not a language code like en or nl']);
    expect(messages(def([q()], { languages: ['en', 'en'] }))).toEqual(['languages: names a language twice']);
    expect(checkDefinition(def([q()], { languages: ['en', 'nl-BE'] }))).toEqual([]);
  });

  it('needs a title in the first language; other languages are optional but must be the template\'s', () => {
    expect(messages(def([q()], { title: undefined }))).toEqual(['title: is required']);
    expect(checkDefinition(def([q()], { languages: ['nl', 'en'], title: { nl: 'Titel' } }))).toEqual([]);
    expect(messages(def([q()], { languages: ['nl', 'en'], title: { en: 'Title' } }))).toEqual(['title: needs the nl text']);
    expect(messages(def([q()], { title: { en: 'T', de: 'T' } }))).toEqual(['title.de: is not one of the template\'s languages (en)']);
    expect(messages(def([q()], { title: { en: 'T', nl: 5 }, languages: ['en', 'nl'] }))).toEqual(['title.nl: must be a text of at most 2000 characters']);
    expect(messages(def([q()], { title: 'x'.repeat(LIMITS.text + 1) }))).toEqual(['title: is longer than 2000 characters']);
    expect(messages(def([q()], { title: 7 }))).toEqual(['title: must be a text or { language: text }']);
  });

  it('needs sections with questions, each section its own id', () => {
    expect(messages(def([q()], { sections: [] }))).toEqual(['sections: a survey needs at least one section']);
    expect(messages(def([]))).toEqual(['sections[0]: a section needs at least one question']);
    const two = def([q()], { sections: [{ id: 's', questions: [q()] }, { id: 's', questions: [q({ id: 'q2' })] }] });
    expect(messages(two)).toEqual(['sections[1].id: needs its own id']);
    const tooMany = def([q()], { sections: Array.from({ length: LIMITS.sections + 1 }, (_, i) => ({ id: `s${i}`, questions: [q({ id: `q${i}` })] })) });
    expect(messages(tooMany)).toEqual(['sections: has more than 30 sections']);
  });

  it('counts questions across sections', () => {
    const many = Array.from({ length: LIMITS.questions + 1 }, (_, i) => q({ id: `q${i}` }));
    expect(messages(def(many))).toEqual(['sections: has more than 150 questions']);
  });
});

describe('checkDefinition — a question', () => {
  it('needs an id, unique in the whole template', () => {
    expect(messages(def([q({ id: '1abc' })]))).toEqual(['sections[0].questions[0].id: needs an id: a letter, then letters, digits, _ or -']);
    expect(messages(def([q({ id: 'a'.repeat(LIMITS.id + 1) })]))[0]).toMatch(/needs an id/);
    expect(messages(def([q(), q()]))).toEqual(['sections[0].questions[1].id: "q1" is used twice']);
    expect(messages(def(['nope']))).toEqual(['sections[0].questions[0]: must be an object']);
  });

  it('needs a text; help is optional', () => {
    expect(messages(def([q({ text: '' })]))).toEqual(['sections[0].questions[0].text: is required']);
    expect(checkDefinition(def([q({ help: 'Say yes when it runs' })]))).toEqual([]);
    expect(messages(def([q({ help: 3 })]))).toEqual(['sections[0].questions[0].help: must be a text or { language: text }']);
  });

  it('knows the answer types, and what each needs', () => {
    expect(messages(def([q({ answer: { type: 'slider' } })]))[0]).toMatch(/answer\.type: must be one of yesNo, choice/);
    expect(messages(def([q({ answer: { type: 'choice', options: [{ value: 'A' }] } })]))).toEqual(['sections[0].questions[0].answer.options: a choice needs at least two options']);
    expect(messages(def([q({ answer: { type: 'choice', options: [{ value: 'A' }, { value: 'A' }] } })]))).toEqual(['sections[0].questions[0].answer.options[1]: repeats the value "A"']);
    expect(messages(def([q({ answer: { type: 'multiChoice', options: [{ value: 'A' }, { label: 'B' }] } })]))).toEqual(['sections[0].questions[0].answer.options[1]: needs a value']);
    const tooMany = Array.from({ length: LIMITS.options + 1 }, (_, i) => ({ value: `v${i}` }));
    expect(messages(def([q({ answer: { type: 'choice', options: tooMany } })]))).toEqual(['sections[0].questions[0].answer.options: has more than 30 options']);
    expect(messages(def([q({ answer: { type: 'confirm' } })]))[0]).toMatch(/answer\.shows: a confirm question names what it shows/);
    expect(messages(def([q({ answer: { type: 'text', maxLength: 0 } })]))).toEqual(['sections[0].questions[0].answer.maxLength: must be a whole number from 1 to 2000']);
    expect(checkDefinition(def([q({ answer: { type: 'text', maxLength: 200 } }), q({ id: 'd', answer: { type: 'date' } })]))).toEqual([]);
  });

  it('asks per row only about a known source, showing only that source\'s columns', () => {
    expect(messages(def([q({ rows: { source: 'groups' } })]))).toEqual(['sections[0].questions[0].rows.source: must be one of members, resources, children']);
    expect(messages(def([q({ rows: { source: 'members', columns: 'jobTitle' } })]))).toEqual(['sections[0].questions[0].rows.columns: must be a list']);
    expect(messages(def([q({ rows: { source: 'members', columns: ['jobTitle', 'owner'] } })])))
      .toEqual([expect.stringMatching(/rows\.columns: owner cannot be shown for members; choose from displayName/)]);
    expect(checkDefinition(def([q({ rows: { source: 'resources', columns: ['owner'] } })]))).toEqual([]);
  });
});

describe('checkDefinition — showWhen', () => {
  const owner = q({ id: 'isOwner' });
  it('depends on an earlier yes/no or choice question, with one of its values', () => {
    expect(checkDefinition(def([owner, q({ id: 'who', showWhen: { question: 'isOwner', equals: 'no' } })]))).toEqual([]);
    expect(messages(def([q({ id: 'who', showWhen: { question: 'isOwner', equals: 'no' } }), owner])))
      .toEqual(['sections[0].questions[0].showWhen.question: must name an earlier question']);
    expect(messages(def([owner, q({ id: 'who', showWhen: { question: 'isOwner', equals: 'maybe' } })])))
      .toEqual(['sections[0].questions[1].showWhen.equals: must be one of yes, no']);
    const text = q({ id: 'note', answer: { type: 'text' } });
    expect(messages(def([text, q({ id: 'who', showWhen: { question: 'note', equals: 'x' } })])))
      .toEqual(['sections[0].questions[1].showWhen.question: "note" has open answers; depend on a yes/no or choice question']);
    const perRow = q({ id: 'row', rows: { source: 'members' } });
    expect(messages(def([perRow, q({ id: 'who', showWhen: { question: 'row', equals: 'yes' } })])))
      .toEqual(['sections[0].questions[1].showWhen.question: cannot depend on a question asked per row']);
  });
});

describe('checkDefinition — becomes', () => {
  const at = 'sections[0].questions[0].becomes';
  it('a description, an alias and a property are about the context; a property names its attribute', () => {
    expect(checkDefinition(def([q({ answer: { type: 'text' }, becomes: { kind: 'description' } })]))).toEqual([]);
    expect(checkDefinition(def([q({ becomes: { kind: 'property', attribute: 'nis2Relevant' } })]))).toEqual([]);
    expect(messages(def([q({ becomes: { kind: 'property' } })]))).toEqual([`${at}.attribute: a property names its attribute (letters, digits, _; e.g. criticality)`]);
    expect(messages(def([q({ becomes: { kind: 'property', attribute: 'has space' } })]))[0]).toMatch(/attribute/);
    expect(messages(def([q({ becomes: { kind: 'alias', about: 'respondent' } })]))).toEqual([`${at}.about: an alias is about the context`]);
    expect(messages(def([q({ becomes: { kind: 'rumour' } })]))[0]).toMatch(/becomes\.kind: must be one of/);
  });

  it('a property may be about a resource row, but not about a member row', () => {
    expect(checkDefinition(def([q({ rows: { source: 'resources' }, answer: { type: 'confirm', shows: 'owner' }, becomes: { kind: 'property', about: 'row', attribute: 'owner' } })]))).toEqual([]);
    expect(messages(def([q({ rows: { source: 'members' }, becomes: { kind: 'property', about: 'row', attribute: 'x' } })])))
      .toEqual([`${at}.about: a property is about the context (or a resource row)`]);
  });

  it('a role is about a person: the respondent, the person answered, or a member row', () => {
    expect(checkDefinition(def([q({ becomes: { kind: 'role', about: 'respondent', relation: { yes: 'owner', no: 'notOwner' } } })]))).toEqual([]);
    expect(checkDefinition(def([q({ answer: { type: 'people' }, becomes: { kind: 'role', about: 'answer', relation: 'dayToDay' } })]))).toEqual([]);
    expect(messages(def([q({ becomes: { kind: 'role', relation: 'owner' } })]))).toEqual([`${at}.about: must be one of context, respondent, answer, row`]);
    expect(messages(def([q({ becomes: { kind: 'role', about: 'context', relation: 'owner' } })]))).toEqual([`${at}.about: a role is about a person: respondent, answer or row`]);
    expect(messages(def([q({ becomes: { kind: 'role', about: 'answer', relation: 'owner' } })]))).toEqual([`${at}.about: "answer" needs a person or people question`]);
    expect(messages(def([q({ becomes: { kind: 'role', about: 'row', relation: 'owner' } })]))).toEqual([`${at}.about: "row" needs a question asked per member`]);
    expect(messages(def([q({ rows: { source: 'members' }, becomes: { kind: 'role', about: 'respondent', relation: 'owner' } })])))
      .toEqual([`${at}.about: a question asked per row is about the row, not the respondent`]);
  });

  it('a relation or status is one known value, or a map from this question\'s answers to known values', () => {
    expect(messages(def([q({ becomes: { kind: 'role', about: 'respondent', relation: 'boss' } })]))).toEqual([`${at}.relation: must be one of owner, notOwner, dayToDay, delegate, member, other`]);
    expect(messages(def([q({ becomes: { kind: 'role', about: 'respondent' } })]))[0]).toMatch(/relation: is required/);
    expect(messages(def([q({ becomes: { kind: 'role', about: 'respondent', relation: { yes: 'owner', maybe: 'other' } } })]))).toEqual([`${at}.relation.maybe: is not an answer of this question (yes, no)`]);
    expect(messages(def([q({ becomes: { kind: 'role', about: 'respondent', relation: { yes: 'boss' } } })]))).toEqual([`${at}.relation.yes: must be one of owner, notOwner, dayToDay, delegate, member, other`]);
    const people = q({ answer: { type: 'people' }, becomes: { kind: 'role', about: 'answer', relation: { yes: 'owner' } } });
    expect(messages(def([people]))).toEqual([`${at}.relation: a map needs a yes/no, confirm or choice question`]);
    const member = q({ rows: { source: 'members' }, becomes: { kind: 'membership', about: 'row', status: { yes: 'current', no: 'gone' } } });
    expect(messages(def([member]))).toEqual([`${at}.status.no: must be one of current, former, joined, left, rejoined`]);
    const choice = q({ answer: { type: 'choice', options: [{ value: 'stays' }, { value: 'leaves' }] }, rows: { source: 'members' }, becomes: { kind: 'membership', about: 'row', status: { stays: 'current', leaves: 'left' } } });
    expect(checkDefinition(def([choice]))).toEqual([]);
  });
});

describe('helpers', () => {
  const d = def([q({ answer: { type: 'choice', options: [{ value: 'A' }, { value: 'B' }] } }), q({ id: 'q2' })], { languages: ['nl', 'en'] });
  it('questionsOf lists the questions in order with their section', () => {
    expect(questionsOf(d).map(x => [x.id, x.sectionId])).toEqual([['q1', 's'], ['q2', 's']]);
    expect(questionsOf(null)).toEqual([]);
  });
  it('answerValues: yes/no for yesNo and confirm, the option values for a choice, null when open', () => {
    expect(answerValues(questionsOf(d)[0])).toEqual(['A', 'B']);
    expect(answerValues(q({ answer: { type: 'confirm', shows: 'x' } }))).toEqual(['yes', 'no']);
    expect(answerValues(q({ answer: { type: 'text' } }))).toBeNull();
  });
  it('textIn falls back to the template\'s first language, then to any', () => {
    expect(textIn({ nl: 'Ja', en: 'Yes' }, 'en', d)).toBe('Yes');
    expect(textIn({ nl: 'Ja', en: 'Yes' }, 'de', d)).toBe('Ja');
    expect(textIn({ en: 'Yes' }, 'de', d)).toBe('Yes');
    expect(textIn('plain', 'en', d)).toBe('plain');
    expect(textIn(undefined, 'en', d)).toBe('');
  });
  it('fill replaces the three placeholders it knows and leaves the rest', () => {
    expect(fill('Is {context} yours, {respondent}? ({row}) {other}', { context: 'Payroll', respondent: 'Anna' })).toBe('Is Payroll yours, Anna? ({row}) {other}');
  });
});
