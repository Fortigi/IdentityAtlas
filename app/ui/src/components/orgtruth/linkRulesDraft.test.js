import { describe, it, expect, vi } from 'vitest';
import {
  SYSTEM_TARGETS, viaLabel, targetTitle, lineField, defaultSignals, defaultThreshold, newRule,
  signalsSummary, ruleLabel, addRule, replaceRule, removeRuleAt, updateRuleSignal, addRuleSignal,
  removeRuleSignal, setRuleThreshold, rowAction, rowName, ruleCounts, lineLabel, relinkProfile,
  renameEntityType, canRename, targetFieldLabel,
} from './linkRulesDraft';

const sig = (attribute, targetField, type, weight) => ({ attribute, targetField, type, weight });

describe('targets and labels', () => {
  it('lists the matchable fields of every system target like the API', () => {
    expect(SYSTEM_TARGETS.map(s => [s.targetType, s.title, s.fields.join(',')])).toEqual([
      ['Principal', 'Account', 'displayName,email,employeeId'],
      ['Identity', 'Person', 'displayName,email,employeeId'],
      ['Resource', 'Group/resource', 'displayName,mail,externalId'],
      ['Context', 'Context', 'displayName'],
    ]);
  });

  it('names the entity itself "name" and a target by its title or list', () => {
    expect(viaLabel('displayName')).toBe('name');
    expect(viaLabel('owner')).toBe('owner');
    expect(targetTitle('Principal')).toBe('Account');
    expect(targetTitle('Resource')).toBe('Group/resource');
    expect(targetTitle('OrgEntity', 'Customer')).toBe('Customer');
    expect(targetTitle('OrgEntity')).toBe('Another list');
    expect(targetTitle('Mystery')).toBe('Mystery');
  });

  it('ends a line on the first signal field, or the other list name', () => {
    expect(lineField({ targetType: 'Principal', signals: [sig('a', 'email', 'exact', 90), sig('a', 'displayName', 'name', 60)] })).toBe('email');
    expect(lineField({ targetType: 'OrgEntity', signals: [sig('a', 'other', 'fuzzy', 100)] })).toBe('displayName');
    expect(lineField({ targetType: 'Context', signals: [] })).toBe('displayName');
  });

  it('summarises signals and labels a rule', () => {
    expect(signalsSummary([sig('a', 'b', 'exact', 80), sig('a', 'b', 'name', 60)])).toBe('exact 80 + name 60');
    expect(signalsSummary(undefined)).toBe('');
    expect(ruleLabel({ entityType: 'Timesheet', targetType: 'OrgEntity', targetEntityType: 'Customer', via: 'column4' }))
      .toBe('Timesheet · column4 → Customer');
    expect(ruleLabel({ entityType: 'Customer', targetType: 'Resource', signals: [sig('displayName', 'displayName', 'exact', 80)] }))
      .toBe('Customer · name → Resource');
  });
});

describe('targetFieldLabel', () => {
  it('calls the name row of another list "name" and keeps a system field as is', () => {
    expect(targetFieldLabel('OrgEntity', 'displayName')).toBe('name');
    expect(targetFieldLabel('Principal', 'displayName')).toBe('displayName');
  });
});

describe('defaults per target', () => {
  it('person targets: exact + name on a name, exact 90 on email or employee id', () => {
    expect(defaultSignals('Principal', 'owner')).toEqual([sig('owner', 'displayName', 'exact', 80), sig('owner', 'displayName', 'name', 60)]);
    expect(defaultSignals('Identity', 'owner', 'email')).toEqual([sig('owner', 'email', 'exact', 90)]);
    expect(defaultSignals('Principal', 'ownerMail')).toEqual([sig('ownerMail', 'email', 'exact', 90)]);
    expect(defaultSignals('Principal', 'E-MAIL address', 'displayName')).toEqual([sig('E-MAIL address', 'email', 'exact', 90)]);
    expect(defaultSignals('Principal', 'Mail', 'employeeId')).toEqual([sig('Mail', 'employeeId', 'exact', 90)]);
    expect(defaultSignals('Principal', 'id', 'employeeId')).toEqual([sig('id', 'employeeId', 'exact', 90)]);
  });

  it('groups: exact 80 + token 50; contexts: exact 80; another list: fuzzy 100 on its name', () => {
    expect(defaultSignals('Resource', 'team', 'mail')).toEqual([sig('team', 'mail', 'exact', 80), sig('team', 'mail', 'token', 50)]);
    expect(defaultSignals('Context', 'dept')).toEqual([sig('dept', 'displayName', 'exact', 80)]);
    expect(defaultSignals('OrgEntity', 'column4', 'whatever')).toEqual([sig('column4', 'displayName', 'fuzzy', 100)]);
  });

  it('thresholds: 60 for another list, 50 otherwise', () => {
    expect(defaultThreshold('OrgEntity')).toBe(60);
    expect(defaultThreshold('Principal')).toBe(50);
  });

  it('builds a new rule to another list with its entity type', () => {
    expect(newRule({ entityType: 'Timesheet', attribute: 'column4' }, { targetType: 'OrgEntity', targetEntityType: 'Customer', field: 'displayName' }))
      .toEqual({
        entityType: 'Timesheet', targetType: 'OrgEntity', via: 'column4', targetEntityType: 'Customer',
        threshold: 60, signals: [sig('column4', 'displayName', 'fuzzy', 100)],
      });
    const sys = newRule({ entityType: 'Customer', attribute: 'owner' }, { targetType: 'Principal', field: 'email' });
    expect(sys).toEqual({ entityType: 'Customer', targetType: 'Principal', via: 'owner', threshold: 50, signals: [sig('owner', 'email', 'exact', 90)] });
    expect('targetEntityType' in sys).toBe(false);
  });
});

describe('the rule list', () => {
  const A = { entityType: 'Customer', targetType: 'Principal', via: 'owner', signals: [] };
  const B = { entityType: 'Customer', targetType: 'Resource', via: 'displayName', signals: [] };

  it('adds a rule and refuses one with the same entity type, target type and via', () => {
    const one = addRule([A], B);
    expect(one).toEqual({ rules: [A, B], error: null });
    const dup = addRule([A, B], { ...A, threshold: 70 });
    expect(dup.rules).toEqual([A, B]);
    expect(dup.error).toBe('Customer already links owner to Principal; edit that rule instead.');
    // a different via, target or entity type is not a duplicate
    expect(addRule([A], { ...A, via: 'team' }).error).toBeNull();
    expect(addRule([A], { ...A, targetType: 'Identity' }).error).toBeNull();
    expect(addRule([A], { ...A, entityType: 'Project' }).error).toBeNull();
  });

  it('refuses two rules to two different lists through the same attribute, as the API does', () => {
    const toCustomer = { entityType: 'Timesheet', targetType: 'OrgEntity', targetEntityType: 'Customer', via: 'column4', signals: [] };
    const toStaff = { ...toCustomer, targetEntityType: 'Staff' };
    expect(addRule([toCustomer], toStaff).error).toBe('Timesheet already links column4 to OrgEntity; edit that rule instead.');
  });

  it('a rule without via is keyed by its first signal attribute', () => {
    const legacy = { entityType: 'Customer', targetType: 'Principal', signals: [sig('owner', 'email', 'exact', 90)] };
    expect(addRule([legacy], A).error).not.toBeNull();
  });

  it('replaces a rule in place, which may keep its own key but not take another', () => {
    const edited = { ...A, threshold: 80 };
    expect(replaceRule([A, B], 0, edited)).toEqual({ rules: [edited, B], error: null });
    const clash = replaceRule([A, B], 1, { ...A });
    expect(clash.rules).toEqual([A, B]);
    expect(clash.error).toMatch(/already links owner/);
  });

  it('removes one rule by index', () => {
    expect(removeRuleAt([A, B], 0)).toEqual([B]);
    expect(removeRuleAt([A, B], 1)).toEqual([A]);
    expect(removeRuleAt([A], 5)).toEqual([A]);
  });
});

describe('editing one rule', () => {
  const rule = { entityType: 'Customer', targetType: 'Principal', via: 'owner', threshold: 50,
    signals: [sig('owner', 'displayName', 'exact', 80), sig('owner', 'displayName', 'name', 60)] };

  it('updates a signal and clamps its weight to 1..100', () => {
    expect(updateRuleSignal(rule, 1, { type: 'fuzzy' }).signals[1]).toEqual(sig('owner', 'displayName', 'fuzzy', 60));
    expect(updateRuleSignal(rule, 0, { weight: '250' }).signals[0].weight).toBe(100);
    expect(updateRuleSignal(rule, 0, { weight: 0 }).signals[0].weight).toBe(1);
    expect(updateRuleSignal(rule, 0, { weight: '42.4' }).signals[0].weight).toBe(42);
    expect(updateRuleSignal(rule, 7, { weight: 1 })).toBe(rule);
    expect(rule.signals[0].weight).toBe(80);
  });

  it('adds a signal on the line field, up to ten', () => {
    const emailRule = { ...rule, signals: [sig('owner', 'email', 'exact', 90)] };
    expect(addRuleSignal(emailRule).signals[1]).toEqual(sig('owner', 'email', 'exact', 50));
    const full = { ...rule, signals: Array.from({ length: 10 }, () => sig('owner', 'displayName', 'exact', 1)) };
    expect(addRuleSignal(full)).toBe(full);
    const nine = { ...rule, signals: full.signals.slice(1) };
    expect(addRuleSignal(nine).signals).toHaveLength(10);
  });

  it('removes a signal but never the last', () => {
    expect(removeRuleSignal(rule, 0).signals).toEqual([sig('owner', 'displayName', 'name', 60)]);
    const one = removeRuleSignal(rule, 1);
    expect(removeRuleSignal(one, 0)).toBe(one);
  });

  it('clamps the threshold to 0..100', () => {
    expect(setRuleThreshold(rule, '75').threshold).toBe(75);
    expect(setRuleThreshold(rule, -3).threshold).toBe(0);
    expect(setRuleThreshold(rule, 101).threshold).toBe(100);
  });
});

describe('canvas interaction', () => {
  const owner = { entityType: 'Customer', attribute: 'owner', source: true, target: null };
  const custName = { entityType: 'Customer', attribute: 'displayName', source: true,
    target: { targetType: 'OrgEntity', targetEntityType: 'Customer', field: 'displayName' } };
  const staffName = { entityType: 'Staff', attribute: 'displayName', source: false,
    target: { targetType: 'OrgEntity', targetEntityType: 'Staff', field: 'displayName' } };
  const email = { source: false, target: { targetType: 'Principal', field: 'email' } };
  const sel = { entityType: 'Customer', attribute: 'owner' };

  it('selects a source row, clears it on a second click, and does nothing for a reader', () => {
    expect(rowAction(null, owner, true)).toEqual({ type: 'select', source: sel });
    expect(rowAction(sel, owner, true)).toEqual({ type: 'clear' });
    expect(rowAction(null, owner, false)).toEqual({ type: 'none' });
    expect(rowAction(sel, email, false)).toEqual({ type: 'none' });
  });

  it('opens a new link on a target row once a source is selected', () => {
    expect(rowAction(sel, email, true)).toEqual({ type: 'open', source: sel, target: email.target });
    expect(rowAction(sel, staffName, true)).toEqual({ type: 'open', source: sel, target: staffName.target });
    expect(rowAction(null, email, true)).toEqual({ type: 'none' });
    expect(rowAction(null, staffName, true)).toEqual({ type: 'none' });
  });

  it('the own name row of the selected type is a source, not a target', () => {
    expect(rowAction(sel, custName, true)).toEqual({ type: 'select', source: { entityType: 'Customer', attribute: 'displayName' } });
    const staffSel = { entityType: 'Staff', attribute: 'team' };
    expect(rowAction(staffSel, custName, true).type).toBe('open');
  });

  it('names a row by what it is, or by the link it makes', () => {
    expect(rowName(null, owner, 'Customer')).toBe('owner on Customer');
    expect(rowName(null, custName, 'Customer')).toBe('name on Customer');
    expect(rowName(null, email, 'Account')).toBe('email on Account');
    expect(rowName(sel, email, 'Account')).toBe('Link Customer owner to Account email');
    expect(rowName(sel, staffName, 'Staff')).toBe('Link Customer owner to Staff name');
    expect(rowName(sel, { source: false, target: { targetType: 'Principal', field: 'displayName' } }, 'Account'))
      .toBe('Link Customer owner to Account displayName');
    expect(rowName(sel, custName, 'Customer')).toBe('name on Customer');
    expect(rowName({ entityType: 'Staff', attribute: 'displayName' }, custName, 'Customer')).toBe('Link Staff name to Customer name');
  });
});

describe('counts from the model', () => {
  const model = {
    links: [
      { entityType: 'Customer', targetType: 'Principal', via: 'owner', accepted: 30, proposed: 2 },
      { entityType: 'Customer', targetType: 'Principal', via: 'team', accepted: 70, proposed: 0 },
      { entityType: 'Customer', targetType: 'Resource', accepted: '5', proposed: null },
    ],
    entityLinks: [
      { fromType: 'Timesheet', toType: 'Customer', via: 'column4', accepted: 850, proposed: 12 },
      { fromType: 'Timesheet', toType: 'Staff', via: 'column4', accepted: 1, proposed: 1 },
    ],
  };

  it('matches entity type, target and via', () => {
    expect(ruleCounts(model, { entityType: 'Customer', targetType: 'Principal', via: 'team' })).toEqual({ accepted: 70, proposed: 0 });
    expect(ruleCounts(model, { entityType: 'Customer', targetType: 'Principal', via: 'owner' })).toEqual({ accepted: 30, proposed: 2 });
    expect(ruleCounts(model, { entityType: 'Customer', targetType: 'Resource', via: 'displayName' })).toEqual({ accepted: 5, proposed: 0 });
    expect(ruleCounts(model, { entityType: 'Customer', targetType: 'Identity', via: 'owner' })).toBeNull();
    expect(ruleCounts(model, { entityType: 'Project', targetType: 'Principal', via: 'owner' })).toBeNull();
  });

  it('matches a link to another list on its entity type', () => {
    expect(ruleCounts(model, { entityType: 'Timesheet', targetType: 'OrgEntity', targetEntityType: 'Customer', via: 'column4' }))
      .toEqual({ accepted: 850, proposed: 12 });
    expect(ruleCounts(model, { entityType: 'Timesheet', targetType: 'OrgEntity', targetEntityType: 'Staff', via: 'column4' }))
      .toEqual({ accepted: 1, proposed: 1 });
    expect(ruleCounts(model, { entityType: 'Timesheet', targetType: 'OrgEntity', targetEntityType: 'Customer', via: 'column5' })).toBeNull();
    expect(ruleCounts(null, { entityType: 'X', targetType: 'OrgEntity', via: 'a' })).toBeNull();
    expect(ruleCounts({}, { entityType: 'X', targetType: 'Principal', via: 'a' })).toBeNull();
  });

  it('labels a line with its match and counts', () => {
    const rule = { signals: [sig('a', 'b', 'exact', 80), sig('a', 'b', 'name', 60)] };
    expect(lineLabel(rule, { accepted: 51, proposed: 9 })).toBe('exact 80 + name 60 · 51 accepted · 9 proposed');
    expect(lineLabel(rule, { accepted: 51, proposed: 0 })).toBe('exact 80 + name 60 · 51 accepted');
    expect(lineLabel(rule, null)).toBe('exact 80 + name 60');
  });
});

describe('API calls', () => {
  const respond = (body, { ok = true, status = 200, bad = false } = {}) =>
    vi.fn(async () => ({ ok, status, json: async () => { if (bad) throw new Error('no json'); return body; } }));

  it('posts the rules to relink and returns the run', async () => {
    const authFetch = respond({ profile: { id: 'p2' }, run: { id: 'r1', status: 'queued' } }, { status: 202 });
    const rules = [{ entityType: 'A', targetType: 'Context', signals: [] }];
    expect(await relinkProfile(authFetch, 'p 1', rules)).toEqual({ ok: true, profile: { id: 'p2' }, run: { id: 'r1', status: 'queued' } });
    const [url, opts] = authFetch.mock.calls[0];
    expect(url).toBe('/api/org-truth/profiles/p%201/relink');
    expect(opts.method).toBe('POST');
    expect(opts.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(opts.body)).toEqual({ linkRules: rules });
  });

  it('returns the error sentence and the list of errors of a 400', async () => {
    const authFetch = respond({ error: 'The link rules are not valid.', errors: ['Link rule 1 needs a signal.'] }, { ok: false, status: 400 });
    expect(await relinkProfile(authFetch, 'p1', [])).toEqual({ ok: false, error: 'The link rules are not valid.', errors: ['Link rule 1 needs a signal.'] });
  });

  it('falls back to the status when the body is not JSON or has no errors list', async () => {
    expect(await relinkProfile(respond(null, { ok: false, status: 502, bad: true }), 'p1', [])).toEqual({ ok: false, error: 'HTTP 502', errors: [] });
    expect(await relinkProfile(respond({ error: 'busy', errors: 'x' }, { ok: false, status: 409 }), 'p1', [])).toEqual({ ok: false, error: 'busy', errors: [] });
  });

  it('renames an entity type with a trimmed name', async () => {
    const authFetch = respond({ profile: { id: 'p3' }, renamedEntities: 4, otherProfiles: [] });
    expect(await renameEntityType(authFetch, 'p1', 'Old', '  New ')).toMatchObject({ ok: true, renamedEntities: 4 });
    expect(authFetch.mock.calls[0][0]).toBe('/api/org-truth/profiles/p1/rename-type');
    expect(JSON.parse(authFetch.mock.calls[0][1].body)).toEqual({ from: 'Old', to: 'New' });
  });

  it('sends a rename only when the name is new and not empty', () => {
    expect(canRename('Old', 'New')).toBe(true);
    expect(canRename('Old', ' Old ')).toBe(false);
    expect(canRename('Old', '   ')).toBe(false);
    expect(canRename('Old', null)).toBe(false);
  });
});
