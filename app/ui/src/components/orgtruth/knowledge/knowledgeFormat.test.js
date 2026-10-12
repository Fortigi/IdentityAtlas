import { describe, it, expect } from 'vitest';
import {
  PREDICATES, predicateLabel, modalityColor, supportColor, isRunActive, progressCount, elapsedSeconds, runResult,
  passageFor, splitHighlight, groupByTopic, resolutionText, matchReasons, transcriptRequest,
  MENTION_TYPES, BANDS, bandOf, bandColor, groupByBand, topicGroups, proposedIds, bulkMessage,
  confidencePartsText, corroborationPill, renamedFrom, mentionEditBody, rescoreText,
} from './knowledgeFormat';

const P1 = { id: 'p1', seq: 1, startChar: 0, endChar: 10, text: 'Anna leads' };
const P2 = { id: 'p2', seq: 2, startChar: 11, endChar: 30, text: 'She works for Bob.' };

describe('knowledgeFormat', () => {
  it('labels every API predicate and falls back to the raw value', () => {
    expect(PREDICATES).toEqual(['memberOf', 'formerMemberOf', 'partOf', 'leads', 'responsibleFor', 'worksForCustomer', 'usesApplication', 'hasProperty', 'other']);
    expect(predicateLabel('worksForCustomer')).toBe('works for customer');
    expect(predicateLabel('somethingNew')).toBe('somethingNew');
    expect(predicateLabel(undefined)).toBe('');
  });

  it('colours modality and support, gray for unknown values', () => {
    expect(modalityColor('stated')).toBe('green');
    expect(modalityColor('correction')).toBe('red');
    expect(modalityColor('x')).toBe('gray');
    expect(supportColor('unsupported')).toBe('red');
    expect(supportColor('unclear')).toBe('amber');
    expect(supportColor(null)).toBe('gray');
  });

  it('treats only queued and running as active', () => {
    expect(isRunActive({ status: 'queued' })).toBe(true);
    expect(isRunActive({ status: 'running' })).toBe(true);
    expect(isRunActive({ status: 'cancelled' })).toBe(false);
    expect(isRunActive(null)).toBe(false);
  });

  it('formats progress done/total only when there is a total', () => {
    expect(progressCount({ details: { progress: { done: 3, total: 8 } } })).toBe('3/8');
    expect(progressCount({ details: { progress: { total: 8 } } })).toBe('0/8');
    expect(progressCount({ details: { progress: { done: 0, total: 0 } } })).toBe('');
    expect(progressCount({})).toBe('');
  });

  it('measures elapsed seconds to finishedAt, or to now', () => {
    expect(elapsedSeconds({ createdAt: '2026-10-11T10:00:00Z', finishedAt: '2026-10-11T10:01:05Z' })).toBe(65);
    expect(elapsedSeconds({ createdAt: '2026-10-11T10:00:00Z' }, Date.parse('2026-10-11T10:00:30Z'))).toBe(30);
    expect(elapsedSeconds({ createdAt: '2026-10-11T10:00:30Z' }, Date.parse('2026-10-11T10:00:00Z'))).toBe(0);
    expect(elapsedSeconds({})).toBeNull();
  });

  it('summarises what a run wrote, its error first', () => {
    expect(runResult({ stats: { written: { claims: 3, mentions: 2 } } })).toBe('3 statements · 2 mentions · 0 findings');
    expect(runResult({ error: 'model timed out', stats: { written: { claims: 3 } } })).toBe('model timed out');
    expect(runResult({ stats: {} })).toBe('');
    expect(runResult(null)).toBe('');
  });

  it('finds the passage of a quote by seq, else by the span that holds it', () => {
    expect(passageFor([P1, P2], { seq: 2, startChar: 0, endChar: 1 })).toBe(P2);
    expect(passageFor([P1, P2], { startChar: 14, endChar: 19 })).toBe(P2);
    expect(passageFor([P1, P2], { seq: 9, startChar: 2, endChar: 5 })).toBe(P1);
    expect(passageFor([P1], { startChar: 5, endChar: 20 })).toBeNull();
    expect(passageFor(null, { startChar: 0, endChar: 1 })).toBeNull();
  });

  it('splits passage text around absolute offsets', () => {
    expect(splitHighlight(P2, 15, 24)).toEqual({ before: 'She ', mark: 'works for', after: ' Bob.' });
    expect(splitHighlight(P2, 11, 29)).toEqual({ before: '', mark: 'She works for Bob.', after: '' });
    expect(splitHighlight(P2, 10, 14)).toBeNull();
    expect(splitHighlight(P2, 20, 20)).toBeNull();
    expect(splitHighlight(P2, 20, 30)).toBeNull();
    expect(splitHighlight(null, 0, 1)).toBeNull();
  });

  it('groups by topic in first-seen order, missing topic as other', () => {
    const g = groupByTopic([{ id: 1, topic: 'membership' }, { id: 2 }, { id: 3, topic: 'membership' }]);
    expect(g).toEqual([
      { topic: 'membership', claims: [{ id: 1, topic: 'membership' }, { id: 3, topic: 'membership' }] },
      { topic: 'other', claims: [{ id: 2 }] },
    ]);
    expect(groupByTopic(undefined)).toEqual([]);
  });

  it('describes a resolution and the reasons of a match', () => {
    expect(resolutionText('unmatched')).toBe('no match found');
    expect(resolutionText('ambiguous')).toMatch(/^ambiguous/);
    expect(resolutionText('weird')).toBe('weird');
    expect(matchReasons({ reasons: ['name', '', 'email'], matchedValue: 'Anna' })).toBe('name · email · matched “Anna”');
    expect(matchReasons({ reasons: [] })).toBe('');
    expect(matchReasons(undefined)).toBe('');
  });

  it('builds a JSON body for pasted text, dropping empty fields', () => {
    const req = transcriptRequest({ text: 'hello', displayName: 'Intake', observedAt: '', speaker: 'Anna', sourceType: 'interview' }, null);
    expect(req).toEqual({ kind: 'json', data: { displayName: 'Intake', speaker: 'Anna', sourceType: 'interview', text: 'hello' } });
    expect(transcriptRequest({}, null)).toEqual({ kind: 'json', data: { text: '' } });
  });

  it('builds multipart form data for a file, leaving the pasted text out', () => {
    const file = new File(['x'], 'a.vtt', { type: 'text/vtt' });
    const req = transcriptRequest({ text: 'ignored', displayName: 'Call', language: 'nl' }, file);
    expect(req.kind).toBe('form');
    expect(req.data.get('file').name).toBe('a.vtt');
    expect(req.data.get('displayName')).toBe('Call');
    expect(req.data.get('language')).toBe('nl');
    expect(req.data.get('text')).toBeNull();
  });
});

// Confidence / bulk-review / rename helpers. Inputs sit on the band edges
// (79/80, 49/50) so an off-by-one or a swapped comparison fails, and the API's
// band deliberately disagrees with confidence once to prove band wins.
const c = (id, confidence, over = {}) => ({ id, confidence, status: 'proposed', topic: 't', ...over });

describe('knowledgeFormat — confidence bands', () => {
  it('lists the API mention types', () => {
    expect(MENTION_TYPES).toEqual(['person', 'team', 'organisation', 'customer', 'application', 'location', 'role', 'concept']);
  });

  it('derives the band on the exact thresholds when the API sent none', () => {
    expect(bandOf({ confidence: 80 })).toBe('high');
    expect(bandOf({ confidence: 79 })).toBe('medium');
    expect(bandOf({ confidence: 50 })).toBe('medium');
    expect(bandOf({ confidence: 49 })).toBe('low');
    expect(bandOf({ confidence: 0 })).toBe('low');
    expect(bandOf({ confidence: null })).toBe('unscored');
    expect(bandOf({ confidence: Number.NaN })).toBe('unscored');
    expect(bandOf({ confidence: '90' })).toBe('unscored');
    expect(bandOf(undefined)).toBe('unscored');
  });

  it('prefers the band the API sent, and ignores an unknown one', () => {
    expect(bandOf({ band: 'low', confidence: 95 })).toBe('low');
    expect(bandOf({ band: 'bogus', confidence: 95 })).toBe('high');
  });

  it('colours the bands green, amber, red; gray otherwise', () => {
    expect(bandColor('high')).toBe('green');
    expect(bandColor('medium')).toBe('amber');
    expect(bandColor('low')).toBe('red');
    expect(bandColor('unscored')).toBe('gray');
    expect(bandColor('x')).toBe('gray');
    expect(BANDS.map(b => b.key)).toEqual(['high', 'medium', 'low', 'unscored']);
  });

  it('groups High, Medium, Low, Not scored in that order whatever the input order, dropping empty bands', () => {
    const groups = groupByBand([c('a', 10), c('b', 85), c('d', null), c('e', 50), c('f', 80), c('g', 49)]);
    expect(groups.map(g => [g.key, g.title, g.claims.map(x => x.id)])).toEqual([
      ['high', 'High confidence', ['b', 'f']],
      ['medium', 'Medium confidence', ['e']],
      ['low', 'Low confidence', ['a', 'g']],
      ['unscored', 'Not scored', ['d']],
    ]);
    expect(groups[0].hint).toBe('≥ 80');
    expect(groups[0].scope).toBe('High confidence');
    expect(groupByBand([c('x', 60)]).map(g => g.key)).toEqual(['medium']);
    expect(groupByBand(null)).toEqual([]);
  });

  it('gives topic groups the same shape with a quoted scope', () => {
    expect(topicGroups([c('a', 1, { topic: 'teams' }), c('b', 1, { topic: '' })])).toEqual([
      { key: 'teams', title: 'teams', hint: '', scope: 'topic “teams”', claims: [c('a', 1, { topic: 'teams' })] },
      { key: 'other', title: 'other', hint: '', scope: 'topic “other”', claims: [c('b', 1, { topic: '' })] },
    ]);
  });
});

describe('knowledgeFormat — bulk review', () => {
  it('takes only the proposed ids', () => {
    expect(proposedIds([c('a', 1), c('b', 1, { status: 'accepted' }), c('d', 1, { status: 'rejected' }), c('e', 1)])).toEqual(['a', 'e']);
    expect(proposedIds(undefined)).toEqual([]);
  });

  it('words the confirmation per verb, count and scope', () => {
    expect(bulkMessage('accepted', 12, 'High confidence')).toBe('Accept the 12 statements in High confidence? Statements already decided are not changed.');
    expect(bulkMessage('rejected', 1, 'Low confidence')).toBe('Reject the 1 statement in Low confidence? Statements already decided are not changed.');
    expect(bulkMessage('accepted', 3, null)).toBe('Accept the 3 shown statements? Statements already decided are not changed.');
    expect(bulkMessage('rejected', 1, null)).toBe('Reject the 1 shown statement? Statements already decided are not changed.');
  });

  it('summarises a rescore answer', () => {
    expect(rescoreText({ scored: 9, corroborated: 4, contradicted: 1 })).toBe('Scored 9 statements: 4 confirmed by data, 1 contradicted.');
    expect(rescoreText(null)).toBe('Scored 0 statements: 0 confirmed by data, 0 contradicted.');
  });
});

describe('knowledgeFormat — score parts, corroboration, rename', () => {
  it('lists the confidence parts in a fixed order, skipping missing ones but keeping zero', () => {
    expect(confidencePartsText({ data: 30, transcript: 60, matching: 10 })).toBe('transcript 60 · matching 10 · data 30');
    expect(confidencePartsText({ transcript: 60, data: 0 })).toBe('transcript 60 · data 0');
    expect(confidencePartsText(null)).toBe('');
  });

  it('turns a verdict into a green or red pill with its detail', () => {
    expect(corroborationPill({ verdict: 'corroborated', kind: 'context', detail: 'member of the group "IT"' }))
      .toEqual({ color: 'green', text: 'confirmed by data', detail: 'member of the group "IT"' });
    expect(corroborationPill({ verdict: 'contradicted' })).toEqual({ color: 'red', text: 'contradicted by data', detail: '' });
    expect(corroborationPill({ verdict: 'unknown' })).toBeNull();
    expect(corroborationPill(null)).toBeNull();
  });

  it('shows the transcript spelling only when it differs from the name', () => {
    expect(renamedFrom({ label: 'Fortigi', originalLabel: 'FortiG' })).toBe('FortiG');
    expect(renamedFrom({ label: 'Fortigi', originalLabel: 'Fortigi' })).toBeNull();
    expect(renamedFrom({ label: 'Fortigi', originalLabel: null })).toBeNull();
    expect(renamedFrom({ label: 'Fortigi' })).toBeNull();
    expect(renamedFrom(undefined)).toBeNull();
  });

  it('trims the new name and keeps the type', () => {
    expect(mentionEditBody({ label: '  Fortigi ', type: 'organisation' })).toEqual({ label: 'Fortigi', type: 'organisation' });
    expect(mentionEditBody({ type: 'team' })).toEqual({ label: '', type: 'team' });
  });
});
