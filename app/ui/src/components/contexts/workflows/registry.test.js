import { describe, it, expect } from 'vitest';
import { actionCardsFor } from './registry';
import MatrixCard from './MatrixCard';
import DownloadReportCard from './DownloadReportCard';
import ComingSoonCard from './ComingSoonCard';

const APP = { id: 'app', contextCategory: 'LogicalApplication', targetType: 'Resource' };
const unit = targetType => ({ id: targetType, contextCategory: 'OrganizationalUnit', targetType });

describe('action registry', () => {
  const cardsOf = attrs => actionCardsFor(attrs).map(c => c.Card);

  it('gives an application the matrix, the entitlement report and the ownership survey, in that order', () => {
    expect(cardsOf(APP)).toEqual([MatrixCard, DownloadReportCard, ComingSoonCard]);
    // On its template, whatever it holds.
    expect(cardsOf({ ...APP, targetType: undefined })).toEqual([MatrixCard, DownloadReportCard, ComingSoonCard]);
  });

  it('gives every organisational unit — of people, accounts or resources — the matrix and the survey', () => {
    for (const t of ['Identity', 'Principal', 'Resource', 'System']) expect(cardsOf(unit(t)), t).toEqual([MatrixCard, ComingSoonCard]);
  });

  it('labels the survey card as the ownership survey', () => {
    const survey = actionCardsFor(APP).find(c => c.Card === ComingSoonCard);
    expect(survey.props).toMatchObject({ title: 'Start ownership survey', testId: 'action-ownership-survey' });
    expect(survey.props.text).toMatch(/^Ask the accountable owner to confirm they own this/);
  });

  it('leaves the survey out of a read-only shared view, and only the survey', () => {
    const shared = attrs => actionCardsFor(attrs, { sharedView: true }).map(c => c.Card);
    expect(shared(APP)).toEqual([MatrixCard, DownloadReportCard]);
    expect(shared(unit('Identity'))).toEqual([MatrixCard]);
  });

  it('gives other templates no actions', () => {
    for (const contextCategory of ['Tag', 'Segment', 'Other', null]) expect(actionCardsFor({ ...APP, contextCategory })).toEqual([]);
  });
});
