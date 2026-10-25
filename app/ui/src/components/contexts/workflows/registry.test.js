import { describe, it, expect } from 'vitest';
import { actionCardsFor } from './registry';
import MatrixCard from './MatrixCard';
import DownloadReportCard from './DownloadReportCard';
import UploadInterviewCard from '@ui/components/contexts/interviews/UploadInterviewCard';
import SendSurveyCard from '@ui/components/contexts/surveys/SendSurveyCard';
import DoSurveyCard from '@ui/components/contexts/surveys/DoSurveyCard';
import RosterCard from '@ui/components/contexts/surveys/RosterCard';

const APP = { id: 'app', contextCategory: 'LogicalApplication', targetType: 'Resource' };
const unit = targetType => ({ id: targetType, contextCategory: 'OrganizationalUnit', targetType });

describe('action registry', () => {
  const cardsOf = attrs => actionCardsFor(attrs).map(c => c.Card);
  const keysOf = (attrs, opts) => actionCardsFor(attrs, opts).map(c => c.key);

  it('gives an application the matrix, the entitlement report, the interview upload and the survey, in that order', () => {
    expect(cardsOf(APP)).toEqual([MatrixCard, DownloadReportCard, UploadInterviewCard, SendSurveyCard, DoSurveyCard]);
    // On its template, whatever it holds.
    expect(cardsOf({ ...APP, targetType: undefined })).toEqual([MatrixCard, DownloadReportCard, UploadInterviewCard, SendSurveyCard, DoSurveyCard]);
  });

  it('gives a unit of accounts or people the matrix, the unit report, the roster, the interview upload and the survey', () => {
    for (const t of ['Identity', 'Principal']) {
      expect(keysOf(unit(t)), t).toEqual(['view-in-matrix', 'download-unit-report', 'roster', 'upload-interview', 'send-survey', 'do-survey']);
    }
    const card = actionCardsFor(unit('Principal')).find(c => c.key === 'download-unit-report');
    expect(card.Card).toBe(DownloadReportCard);
    expect(card.props).toMatchObject({ report: 'unit-members', title: 'Download unit report', testId: 'action-download-unit-report' });
    expect(actionCardsFor(unit('Identity')).find(c => c.key === 'roster').Card).toBe(RosterCard);
  });

  it('gives a unit of resources (or systems) no report card and no roster', () => {
    for (const t of ['Resource', 'System']) expect(keysOf(unit(t)), t).toEqual(['view-in-matrix', 'upload-interview', 'send-survey', 'do-survey']);
  });

  it('offers no announced-but-unbuilt cards: the survey cards are the built ones, and there is no member review card', () => {
    for (const attrs of [APP, unit('Identity'), unit('Principal'), unit('Resource')]) {
      expect(actionCardsFor(attrs).filter(c => /survey/.test(c.key)).map(c => c.Card)).toEqual([SendSurveyCard, DoSurveyCard]);
      expect(keysOf(attrs).filter(k => /review-members/.test(k))).toEqual([]);
    }
  });

  // A context owner's read-only page: no matrix (an in-app page they cannot open),
  // no interview upload and no survey sending (an analyst's moves); the reports,
  // a unit's roster and doing a survey in place (for the owner themselves) stay.
  it('keeps the reports, the roster and Do survey on a read-only shared view', () => {
    expect(keysOf(APP, { sharedView: true })).toEqual(['download-report', 'do-survey']);
    expect(keysOf(unit('Identity'), { sharedView: true })).toEqual(['download-unit-report', 'roster', 'do-survey']);
    expect(keysOf(unit('Resource'), { sharedView: true })).toEqual(['do-survey']);
  });

  it('gives other templates no actions', () => {
    for (const contextCategory of ['Tag', 'Segment', 'Other', null]) expect(actionCardsFor({ ...APP, contextCategory })).toEqual([]);
  });
});
