// "Was a survey sent to this signed-in person?" — the mapping and the lookup are
// injected; the SQL is contract-tests/surveyTemplates.contract.test.js's.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/connection.js');
vi.mock('../contexts/surveys/store.js', () => ({ hasSurvey: vi.fn() }));
const { hasSurvey } = await import('../contexts/surveys/store.js');
const { isSurveyRespondent } = await import('./surveyRespondent.js');

const db = { queryOne: vi.fn() };

describe('isSurveyRespondent', () => {
  it('is false for someone who is nobody in our data, without asking', async () => {
    expect(await isSurveyRespondent({ oid: 'x' }, { resolveMe: async () => null, db })).toBe(false);
    expect(hasSurvey).not.toHaveBeenCalled();
  });

  it('asks about their account and their person', async () => {
    hasSurvey.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const me = { principal: { id: 'p' }, identity: { id: 'i' } };
    expect(await isSurveyRespondent({}, { resolveMe: async () => me, db })).toBe(true);
    expect(hasSurvey.mock.calls[0]).toEqual([db, 'p', 'i']);
    expect(await isSurveyRespondent({}, { resolveMe: async () => ({ principal: { id: 'p' }, identity: null }), db })).toBe(false);
    expect(hasSurvey.mock.calls[1]).toEqual([db, 'p', null]);
  });

  it('is false before the survey tables exist, and rethrows anything else', async () => {
    const me = async () => ({ principal: { id: 'p' } });
    hasSurvey.mockRejectedValueOnce(Object.assign(new Error('relation "SurveyRequests" does not exist'), { code: '42P01' }));
    expect(await isSurveyRespondent({}, { resolveMe: me, db })).toBe(false);
    hasSurvey.mockRejectedValueOnce(new Error('db down'));
    await expect(isSurveyRespondent({}, { resolveMe: me, db })).rejects.toThrow('db down');
  });
});
