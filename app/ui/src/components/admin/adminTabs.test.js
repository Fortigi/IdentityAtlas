import { describe, it, expect } from 'vitest';
import { ADMIN_TABS, visibleAdminTabs, shouldLeaveTab, leaveTarget } from './adminTabs.js';

describe('adminTabs', () => {
  it('keeps the Authentication tab, gated on admin.auth', () => {
    const auth = ADMIN_TABS.find(t => t.key === 'auth');
    expect(auth).toBeTruthy();
    expect(auth.requires).toEqual(['admin.auth']);
  });

  it('surfaces Roles & Permissions as its own admin.auth-gated tab (#786)', () => {
    const roles = ADMIN_TABS.find(t => t.key === 'roles');
    expect(roles).toBeTruthy();
    expect(roles.label).toBe('Roles & Permissions');
    expect(roles.requires).toEqual(['admin.auth']);
    // Visible to a user with admin.auth on any platform (permission-driven only).
    expect(visibleAdminTabs(new Set(['admin.auth']), false).map(t => t.key)).toContain('roles');
  });

  it('shows the Authentication tab to a user with admin.auth — on any platform', () => {
    // The whole point of the fix: visibility is permission-driven only, never
    // suppressed by the deployment platform.
    const tabs = visibleAdminTabs(new Set(['admin.auth']), false);
    expect(tabs.map(t => t.key)).toContain('auth');
  });

  it('hides the Authentication tab from a user without admin.auth', () => {
    const tabs = visibleAdminTabs(new Set(['admin.crawlers']), false);
    expect(tabs.map(t => t.key)).not.toContain('auth');
  });

  it('hosts Shared Matrices as a data.share-gated sub-tab, not a top-level tab (#1166)', () => {
    const shares = ADMIN_TABS.find(t => t.key === 'shares');
    expect(shares).toBeTruthy();
    expect(shares.label).toBe('Shared Matrices');
    expect(shares.requires).toEqual(['data.share']);
    const on = { matrixSharing: true };
    // A RoleMiner has data.share but no admin.* — they must still reach it.
    expect(visibleAdminTabs(new Set(['data.share']), false, ADMIN_TABS, on).map(t => t.key)).toContain('shares');
    // …and an admin without it does not see a tab they cannot use.
    expect(visibleAdminTabs(new Set(['admin.crawlers']), false, ADMIN_TABS, on).map(t => t.key)).not.toContain('shares');
  });

  it('hides Shared Matrices while the matrixSharing flag is off, whatever the permissions', () => {
    const keys = (features) => visibleAdminTabs(new Set(['data.share']), false, ADMIN_TABS, features).map(t => t.key);
    expect(keys({ matrixSharing: false })).not.toContain('shares');
    expect(keys(undefined)).not.toContain('shares');          // flags not supplied → off
    expect(keys({ matrixSharing: 'true' })).not.toContain('shares'); // only a real boolean true opens it
    // A wildcard admin is no exception: there is no page to manage.
    expect(visibleAdminTabs(new Set(), true).map(t => t.key)).not.toContain('shares');
    // The flag only ever narrows: tabs without one are unaffected by it.
    expect(keys({ matrixSharing: false })).toEqual(expect.arrayContaining(['performance', 'about']));
  });

  it('a wildcard user sees every tab once the flags they depend on are on', () => {
    const tabs = visibleAdminTabs(new Set(), true, ADMIN_TABS, { matrixSharing: true, riskScoring: true, compositionReview: true });
    expect(tabs).toHaveLength(ADMIN_TABS.length);
  });

  // Risk scoring is experimental: off means its tabs do not exist, whatever the
  // permissions. Both tabs are checked against the SAME users with only the flag
  // changing, so a tab that ignored the flag would still show and fail.
  describe('risk scoring tabs', () => {
    const keys = (perms, features) => visibleAdminTabs(new Set(perms), false, ADMIN_TABS, features).map(t => t.key);

    it('are gated on the riskScoring flag', () => {
      for (const key of ['risk-scoring', 'llm']) {
        expect(ADMIN_TABS.find(t => t.key === key).feature).toBe('riskScoring');
      }
    });

    it('show for their permissions while the flag is on', () => {
      expect(keys(['admin.llm'], { riskScoring: true })).toEqual(expect.arrayContaining(['risk-scoring', 'llm']));
      // admin.crawlers runs scoring but does not manage the provider.
      const crawlers = keys(['admin.crawlers'], { riskScoring: true });
      expect(crawlers).toContain('risk-scoring');
      expect(crawlers).not.toContain('llm');
    });

    it('are hidden while the flag is off, unreported, or not a real true — wildcard included', () => {
      for (const features of [{ riskScoring: false }, {}, undefined, { riskScoring: 'true' }]) {
        const k = keys(['admin.llm', 'admin.crawlers'], features);
        expect(k).not.toContain('risk-scoring');
        expect(k).not.toContain('llm');
        expect(k).toContain('crawlers'); // the flag only narrows
      }
      const wildcard = visibleAdminTabs(new Set(), true, ADMIN_TABS, { riskScoring: false }).map(t => t.key);
      expect(wildcard).not.toContain('risk-scoring');
      expect(wildcard).not.toContain('llm');
    });

    it('names the LLM tab after what it is for: the risk-scoring model only', () => {
      expect(ADMIN_TABS.find(t => t.key === 'llm').label).toBe('Risk Scoring LLM');
    });
  });

  it('gates the Experimental tab on admin.feature-flags — the permission that owns the toggle', () => {
    const experimental = ADMIN_TABS.find(t => t.key === 'experimental');
    expect(experimental).toBeTruthy();
    expect(experimental.label).toBe('Experimental');
    expect(experimental.requires).toEqual(['admin.feature-flags']);
    expect(visibleAdminTabs(new Set(['admin.feature-flags']), false).map(t => t.key)).toContain('experimental');
    // An admin who can run crawlers but not flip flags must not see it.
    expect(visibleAdminTabs(new Set(['admin.crawlers']), false).map(t => t.key)).not.toContain('experimental');
  });

  it('always shows tabs with no `requires` (Performance, About)', () => {
    const tabs = visibleAdminTabs(new Set(), false);
    expect(tabs.map(t => t.key)).toEqual(expect.arrayContaining(['performance', 'about']));
  });
});

describe('shouldLeaveTab', () => {
  const visible = (features) => visibleAdminTabs(new Set(['data.share', 'admin.crawlers']), false, ADMIN_TABS, features);

  it('waits on a flag /api/features has not reported yet, instead of bouncing', () => {
    // The app's placeholder flags before /api/features answers: matrixSharing absent.
    const early = { accountLinking: true };
    expect(visible(early).map(t => t.key)).not.toContain('shares');
    expect(shouldLeaveTab('shares', visible(early), early)).toBe(false);
  });

  it('leaves once the flag is reported off, and stays once it is reported on', () => {
    expect(shouldLeaveTab('shares', visible({ matrixSharing: false }), { matrixSharing: false })).toBe(true);
    expect(shouldLeaveTab('shares', visible({ matrixSharing: true }), { matrixSharing: true })).toBe(false);
  });

  it('leaves a permission-hidden tab straight away — only flags are waited on', () => {
    const tabs = visibleAdminTabs(new Set(['data.share']), false, ADMIN_TABS, {});
    expect(shouldLeaveTab('crawlers', tabs, {})).toBe(true);
  });

  it('never leaves when nothing is visible yet or the tab is visible', () => {
    expect(shouldLeaveTab('crawlers', [], {})).toBe(false);
    expect(shouldLeaveTab('about', visible({}), {})).toBe(false);
    expect(shouldLeaveTab('about', visible({}), null)).toBe(false);
  });
});

describe('leaveTarget', () => {
  const tabs = (perms, features) => visibleAdminTabs(new Set(perms), false, ADMIN_TABS, features);

  it('sends a risk-scoring or LLM deep link to Experimental — where the switch is — when that is visible', () => {
    const visible = tabs(['admin.llm', 'admin.crawlers', 'admin.feature-flags'], { riskScoring: false });
    expect(shouldLeaveTab('llm', visible, { riskScoring: false })).toBe(true);
    expect(leaveTarget('llm', visible)).toBe('experimental');
    expect(leaveTarget('risk-scoring', visible)).toBe('experimental');
  });

  it('falls back to the first visible tab when the user cannot see Experimental', () => {
    const visible = tabs(['admin.llm', 'admin.crawlers'], { riskScoring: false });
    expect(leaveTarget('llm', visible)).toBe('crawlers');
    // Not Crawlers by default: the first tab THIS user can see (Performance needs no permission).
    expect(leaveTarget('llm', tabs(['admin.auth'], {}))).toBe('performance');
  });

  it('a tab without leaveTo goes to the first visible tab, and nothing visible means Crawlers', () => {
    const visible = tabs(['admin.auth', 'admin.feature-flags'], {});
    expect(leaveTarget('crawlers', visible)).toBe('performance');
    expect(leaveTarget('crawlers', [])).toBe('crawlers');
  });
});

describe('the review campaigns tab', () => {
  const keys = (perms, features) => visibleAdminTabs(new Set(perms), false, ADMIN_TABS, features).map(t => t.key);

  it('exists only with its permission while Composition review is on', () => {
    expect(keys(['admin.review-campaigns'], { compositionReview: true })).toContain('review-campaigns');
    expect(keys(['admin.review-campaigns'], { compositionReview: false })).not.toContain('review-campaigns');
    expect(keys(['admin.review-campaigns'], {})).not.toContain('review-campaigns');
    expect(keys(['admin.feature-flags', 'data.write.certifications'], { compositionReview: true })).not.toContain('review-campaigns');
  });

  it('sends someone who lands on it while the feature is off to Experimental, where its switch is', () => {
    const visible = visibleAdminTabs(new Set(), true, ADMIN_TABS, { compositionReview: false });
    expect(shouldLeaveTab('review-campaigns', visible, { compositionReview: false })).toBe(true);
    expect(leaveTarget('review-campaigns', visible)).toBe('experimental');
  });
});
