import { describe, it, expect } from 'vitest';
import {
  WAYS, ACCESS_FILTERS, REVIEW_FILTER, controlSummary, filterMembers, groupParticipants, participantLabel, participantNotes, matchesAccessFilter, formatDuration, describeExpiry, ruleLabel, approvalText, removalText, showsRequestsAndReviews,
} from './accessModel';

const role = (waysIn, waysOut) => ({ accessModel: { waysIn, waysOut } });

describe('matchesAccessFilter', () => {
  it('passes everything without a filter', () => {
    expect(matchesAccessFilter({}, null)).toBe(true);
  });

  it('matches a way among several', () => {
    const r = role(['Request', 'Assigned'], ['Rule', 'Review']);
    expect(matchesAccessFilter(r, 'in:Assigned')).toBe(true);
    expect(matchesAccessFilter(r, 'out:Review')).toBe(true);
    expect(matchesAccessFilter(r, 'in:Rule')).toBe(false);
  });

  it('keeps the two directions apart', () => {
    const r = role(['Request'], ['Rule']);
    expect(matchesAccessFilter(r, 'out:Rule')).toBe(true);
    expect(matchesAccessFilter(r, 'in:Rule')).toBe(false);
  });

  it('treats a role without a model as Unknown', () => {
    expect(matchesAccessFilter({}, 'in:Unknown')).toBe(true);
    expect(matchesAccessFilter({}, 'out:Rule')).toBe(false);
  });
});

describe('the type filter', () => {
  it('matches the primary type', () => {
    const r = { accessModel: { control: 'Manual', waysIn: ['Request'], waysOut: [] } };
    expect(matchesAccessFilter(r, 'control:Manual')).toBe(true);
    expect(matchesAccessFilter(r, 'control:Automatic')).toBe(false);
  });
  it('treats a role without a type as Unknown', () => {
    expect(matchesAccessFilter({}, 'control:Unknown')).toBe(true);
  });
});

describe('controlSummary', () => {
  it('says nobody has to review a rule-only role', () => {
    expect(controlSummary({ control: 'Automatic' }, 10, 10)).toMatch(/nobody has to review/);
  });
  it('counts only the people no rule covers', () => {
    expect(controlSummary({ control: 'Manual' }, 13, 10)).toContain('3 people hold it');
  });
  it('words one person correctly', () => {
    expect(controlSummary({ control: 'Manual' }, 3, 2)).toContain('1 person holds it');
  });
  it('never counts below zero', () => {
    expect(controlSummary({ control: 'Manual' }, 1, 5)).toContain('0 people hold it');
  });
  it.each([[null], [{ control: 'Unknown' }]])('admits it cannot tell for %j', (m) => {
    expect(controlSummary(m)).toMatch(/does not say enough/);
  });
});

describe('participantLabel', () => {
  it.each([
    [{ subjectType: 'User', displayName: 'Ann' }, 'Ann'],
    [{ subjectType: 'User', principalId: 'id' }, 'id'],
    [{ subjectType: 'Group', groupId: 'g' }, 'g'],
    [{ subjectType: 'Other' }, 'Someone'],
    [{ subjectType: 'Manager', managerLevel: 1 }, "The person's manager"],
    [{ subjectType: 'Manager' }, "The person's manager"],
    [{ subjectType: 'Manager', managerLevel: 2 }, 'Manager, 2 levels up'],
    [{ subjectType: 'Sponsor' }, 'Sponsors'],
    [{ subjectType: 'Self' }, 'The person themselves'],
    [{ subjectType: 'Organization', displayName: 'Contoso' }, 'Contoso'],
    [{ subjectType: 'Organization' }, 'A connected organization'],
    [{ subjectType: 'Rule', rule: 'r', displayName: 'd' }, 'r'],
    [{ subjectType: 'Rule', displayName: 'd' }, 'd'],
    [{ subjectType: 'Rule' }, 'A rule'],
  ])('%j → %s', (p, text) => expect(participantLabel(p)).toBe(text));
});

describe('participantNotes', () => {
  it('states everything that applies', () => {
    expect(participantNotes({ participation: 'Approver', subjectType: 'Group', isFallback: true, onBehalf: true, stage: 2 }))
      .toEqual(['group', 'fallback', 'on behalf of someone', 'stage 2']);
  });
  it('does not mention the first stage, or a stage for a reviewer', () => {
    expect(participantNotes({ participation: 'Approver', subjectType: 'User', stage: 1 })).toEqual([]);
    expect(participantNotes({ participation: 'Reviewer', subjectType: 'User', stage: 2 })).toEqual([]);
  });
});

describe('groupParticipants', () => {
  it('groups by participation, one line per subject, main before fallback', () => {
    const out = groupParticipants([
      { participation: 'Reviewer', subjectType: 'User', principalId: 'f', isFallback: true },
      { participation: 'Reviewer', subjectType: 'Manager', isFallback: false },
      { participation: 'Reviewer', subjectType: 'Manager', isFallback: false },
      { participation: 'Approver', subjectType: 'User', principalId: 'a', isFallback: false },
    ]);
    expect(out.Reviewer.map(p => p.subjectType)).toEqual(['Manager', 'User']);
    expect(out.Approver).toHaveLength(1);
    expect(out.Requestor).toEqual([]);
  });
  it('skips a participation it does not know', () => {
    const out = groupParticipants([{ participation: 'Owner', subjectType: 'User' }]);
    expect(Object.values(out).flat()).toEqual([]);
  });
});

describe('filterMembers — needs review', () => {
  const rows = [{ principalId: 'a', automatic: true, howHeld: ['Rule'] }, { principalId: 'b', automatic: false, howHeld: ['Request'] }];
  it('keeps only the people no rule covers', () => {
    expect(filterMembers(rows, '', REVIEW_FILTER).map(r => r.principalId)).toEqual(['b']);
  });
});

describe('the vocabulary', () => {
  it('offers a label for every filter value', () => {
    for (const { direction, ways } of ACCESS_FILTERS) {
      for (const way of ways) expect(WAYS[direction][way]?.label).toBeTruthy();
    }
  });
});

describe('formatDuration', () => {
  it.each([
    ['P365D', '365 days'], ['P1D', '1 day'], ['P2W', '14 days'], ['P1W2D', '9 days'],
    ['P3M', '3 months'], ['P1Y', '1 year'], ['P2Y1M', '2 years 1 month'],
  ])('%s is %s', (iso, text) => expect(formatDuration(iso)).toBe(text));

  it.each([[null], [''], ['soon'], ['P0D'], ['P']])('is null for %j', (iso) => expect(formatDuration(iso)).toBeNull());
});

describe('describeExpiry', () => {
  const fmt = (d) => `date(${d})`;
  it('states a duration', () => expect(describeExpiry({ type: 'afterDuration', duration: 'P30D' }, fmt)).toBe('Ends after 30 days'));
  it('survives a duration it cannot read', () => expect(describeExpiry({ type: 'afterDuration', duration: 'x' }, fmt)).toBe('Ends after a set time'));
  it('states a date', () => expect(describeExpiry({ type: 'afterDateTime', endDateTime: 'D' }, fmt)).toBe('Ends on date(D)'));
  it('survives a missing date', () => expect(describeExpiry({ type: 'afterDateTime' }, fmt)).toBe('Ends on a set date'));
  it.each([[null], [{ type: 'noExpiration' }]])('is null for %j', (e) => expect(describeExpiry(e, fmt)).toBeNull());
});

describe('ruleLabel', () => {
  it.each([
    [true, true, 'Added and removed by this rule'],
    [true, false, 'Added by this rule'],
    [false, true, 'Removed when someone stops matching'],
    [false, false, 'Who may request it'],
  ])('add=%s remove=%s', (hasAutoAddRule, hasAutoRemoveRule, text) => {
    expect(ruleLabel({ hasAutoAddRule, hasAutoRemoveRule })).toBe(text);
  });
});

describe('approvalText', () => {
  it('says nothing for a policy nobody can request through', () => {
    expect(approvalText({ allowsRequest: false, requiresApproval: true })).toBeNull();
  });
  it('states that approval is needed', () => expect(approvalText({ allowsRequest: true, requiresApproval: true })).toMatch(/need approval/));
  it('states that it is not', () => expect(approvalText({ allowsRequest: true, requiresApproval: false })).toMatch(/without approval/));
  it('says nothing when the source does not', () => expect(approvalText({ allowsRequest: true, requiresApproval: null })).toBeNull());
});

describe('removalText', () => {
  it('explains a removal rule that has no rule text', () => {
    expect(removalText({ hasAutoRemoveRule: true, targetRule: null })).toMatch(/leaves/);
  });
  it('stays quiet when the rule is shown', () => expect(removalText({ hasAutoRemoveRule: true, targetRule: 'x' })).toBeNull());
  it('stays quiet without a removal rule', () => expect(removalText({ hasAutoRemoveRule: false })).toBeNull());
});

describe('showsRequestsAndReviews', () => {
  it.each([
    [{ accessModel: { waysIn: ['Request'], waysOut: [] } }, true],
    [{ accessModel: { waysIn: ['Rule'], waysOut: ['Review'] } }, true],
    [{ accessModel: { waysIn: ['Rule'], waysOut: [] }, reviewCount: 2 }, true],
    [{ accessModel: { waysIn: ['Rule'], waysOut: [] }, pendingRequestCount: 1 }, true],
    [{ accessModel: { waysIn: ['Rule'], waysOut: ['Rule'] }, reviewCount: 0, pendingRequestCount: 0 }, false],
    [{}, false],
  ])('%j → %s', (data, expected) => expect(showsRequestsAndReviews(data)).toBe(expected));
});
