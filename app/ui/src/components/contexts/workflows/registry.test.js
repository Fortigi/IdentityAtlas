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

  const keysOf = (attrs, opts) => actionCardsFor(attrs, opts).map(c => c.key);

  it('gives a unit of accounts or people the matrix, the unit report and the survey', () => {
    for (const t of ['Identity', 'Principal']) {
      expect(keysOf(unit(t)), t).toEqual(['view-in-matrix', 'download-unit-report', 'manager-survey', 'review-members']);
    }
    const card = actionCardsFor(unit('Principal')).find(c => c.key === 'download-unit-report');
    expect(card.Card).toBe(DownloadReportCard);
    expect(card.props).toMatchObject({ report: 'unit-members', title: 'Download unit report', testId: 'action-download-unit-report' });
  });

  it('gives a unit of resources (or systems) no report card', () => {
    for (const t of ['Resource', 'System']) expect(keysOf(unit(t)), t).toEqual(['view-in-matrix', 'manager-survey', 'review-members']);
  });

  it('words the survey per template: an owner for an application, a manager for a unit', () => {
    const props = (attrs, key) => actionCardsFor(attrs).find(c => c.key === key).props;
    expect(props(APP, 'ownership-survey')).toMatchObject({ title: 'Start ownership survey', testId: 'action-ownership-survey' });
    expect(props(APP, 'ownership-survey').text).toMatch(/^Ask the accountable owner to confirm they own this/);
    expect(props(unit('Identity'), 'manager-survey')).toMatchObject({ title: 'Start manager survey', testId: 'action-manager-survey' });
    expect(props(unit('Identity'), 'manager-survey').text).toMatch(/^Ask the manager to confirm they lead this team/);
    expect(props(unit('Principal'), 'review-members')).toMatchObject({ title: 'Review team members', button: 'Start review' });
    // Every coming-soon card is a ComingSoonCard.
    for (const key of ['manager-survey', 'review-members']) {
      expect(actionCardsFor(unit('Identity')).find(c => c.key === key).Card).toBe(ComingSoonCard);
    }
  });

  it('leaves the survey out of a read-only shared view, and only the survey', () => {
    const shared = attrs => actionCardsFor(attrs, { sharedView: true }).map(c => c.Card);
    expect(shared(APP)).toEqual([MatrixCard, DownloadReportCard]);
    // A context owner's own unit keeps its report; the surveys and the review are the analyst's.
    expect(keysOf(unit('Identity'), { sharedView: true })).toEqual(['view-in-matrix', 'download-unit-report']);
  });

  it('gives other templates no actions', () => {
    for (const contextCategory of ['Tag', 'Segment', 'Other', null]) expect(actionCardsFor({ ...APP, contextCategory })).toEqual([]);
  });
});
