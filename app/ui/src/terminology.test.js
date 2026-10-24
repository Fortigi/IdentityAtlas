import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getRootNodes } from '@ui/components/entityGraphShape';

// Guards against internal/legacy jargon leaking back into user-facing strings.
// Targeted at specific files + phrases so it won't false-positive on code
// comments. Seed of the "terminology linter" proposed in the UX audit.
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');

describe('user-facing terminology', () => {
  it('Excel export does not use the German "SOLL" jargon', () => {
    expect(read('utils/exportToExcel.js')).not.toContain('SOLL');
  });

  it('Dashboard Trends presents Business Role as one concept (not "Access Package or Business Role")', () => {
    expect(read('components/DashboardTrendsTab.jsx')).not.toContain('Access Package or Business Role');
  });

  // Governance copy in views that span every connected system. They must name
  // the universal concept — "business role" — and not pair it with, or replace
  // it by, Entra's synonym "access package". Both files below are free of that
  // word in comments too, so a plain source scan is safe here.
  it.each([
    'components/matrix/MatrixLegend.jsx',
    'components/DashboardTrendsTab.jsx',
  ])('%s explains governance by business role only, with no vendor synonym', (rel) => {
    const src = read(rel);
    // Positive half: the file really is governance copy, so "no access package"
    // can't pass merely because the subject went missing.
    expect(src).toMatch(/business[\s-]*role/i);
    expect(src).not.toMatch(/access[\s-]*packages?/i);
  });
});

// ─── Source-neutral vocabulary in the entity graph ───────────────────
//
// The relationship graph on every entity detail page renders whatever systems
// happen to be connected. The data model deliberately collapses each vendor's
// name for a concept into one universal type — an Entra access package, an
// Omada business role and a SailPoint access profile are all
// `resourceType='BusinessRole'`, and the count behind that category
// (`accessPackageCount`) is computed from `Resources."governanceResource"`
// with no system filter at all. So a *category label* in this graph may never
// carry one vendor's word: on a SailPoint IdentityIQ deployment "Access
// Packages" names nothing the user has ever seen.
//
// Item labels are exempt — those are `displayName`s that come from the data.
// Category keys are exempt too: they are internal routing identifiers that
// name API paths (`/api/user/:id/access-packages`) and hash routes.

const VENDOR_VOCABULARY = [
  { vendor: 'Entra', term: 'access package',  pattern: /access[\s-]*packages?/i },
  { vendor: 'Entra', term: 'directory role',  pattern: /directory[\s-]*roles?/i },
  { vendor: 'Entra', term: 'app role',        pattern: /\bapp[\s-]*roles?\b/i },
  { vendor: 'Entra', term: 'tenant',          pattern: /\btenants?\b/i },
  { vendor: 'Entra', term: 'Azure AD',        pattern: /\bazure[\s-]*ad\b/i },
  { vendor: 'Entra', term: 'AAD',             pattern: /\bAAD\b/ },
  { vendor: 'Entra', term: 'Entra',           pattern: /\bentra\b/i },
  { vendor: 'Entra', term: 'Microsoft 365',   pattern: /\b(m365|microsoft[\s-]*365|office[\s-]*365)\b/i },
  { vendor: 'Omada', term: 'Omada',           pattern: /\bomada\b/i },
  { vendor: 'SailPoint', term: 'SailPoint',   pattern: /\bsailpoint\b/i },
  { vendor: 'SailPoint', term: 'IdentityIQ',  pattern: /\b(identity[\s-]*iq|IIQ)\b/i },
  { vendor: 'SailPoint', term: 'access profile', pattern: /access[\s-]*profiles?/i },
];

/** First vendor term the label matches, or null. */
function vendorHit(label) {
  return VENDOR_VOCABULARY.find((v) => v.pattern.test(label)) || null;
}

// A core payload with EVERY optional count non-zero, so `getRootNodes` emits
// the conditional categories too (linked resource, owners, sponsors, owned
// agents, sponsored guests) rather than only the always-present ones. Third
// element is how many categories that maximal core must yield.
const MAXIMAL_CORES = {
  user: [{
    membershipByType: { Direct: 1, Indirect: 1, Eligible: 1 },
    directReportCount: 1, contextCount: 1, accessPackageCount: 1,
    linkedResource: { id: 'r1', displayName: 'Agent app' },
    ownerCount: 1, sponsorCount: 1, ownedAgentCount: 1, sponsoredGuestCount: 1,
  }, {
    manager: { id: 'm1', displayName: 'Boss' },
    identityInfo: { identity: { id: 'i1' } },
    recent: { addedCount: 1, removedCount: 1 },
  }, 15],
  resource: [{
    assignmentByType: { Direct: 1, Indirect: 1, Eligible: 1 },
    accessPackageCount: 1, parentResourceCount: 1, contextCount: 1,
  }, {}, 6],
  'access-package': [{
    assignmentCount: 1, groupCount: 1, attributes: { catalogId: 'c1' },
  }, {}, 3],
  identity: [{ members: [{ principalId: 'p1' }], contextCount: 1 }, {}, 2],
  context: [{ members: [{ id: 'p1' }], subContexts: [{ id: 's1' }] }, {}, 2],
};

describe('entity graph vocabulary is source-neutral', () => {
  // Guard the guard: a pattern list that matched nothing would let every
  // assertion below pass silently.
  it('recognises the vendor words it is meant to catch', () => {
    expect(vendorHit('Access Packages')).toMatchObject({ vendor: 'Entra', term: 'access package' });
    expect(vendorHit('Azure AD Groups')).toMatchObject({ term: 'Azure AD' });
    expect(vendorHit('Omada Business Roles')).toMatchObject({ vendor: 'Omada' });
    expect(vendorHit('Access Profiles')).toMatchObject({ vendor: 'SailPoint' });
    expect(vendorHit('Entra Directory Roles')).not.toBeNull();
    // …and does not fire on the source-neutral vocabulary we actually use.
    for (const ok of ['Business Roles', 'Direct', 'Indirect', 'Eligible',
      'Linked Accounts', 'Contexts', 'Member Of', 'Direct Members', 'Sub-contexts']) {
      expect(vendorHit(ok), `"${ok}" should not be flagged`).toBeNull();
    }
  });

  it.each(Object.keys(MAXIMAL_CORES))('no %s category label names one vendor', (kind) => {
    const [core, extras, minNodes] = MAXIMAL_CORES[kind];
    const nodes = getRootNodes(kind, core, extras);
    // Sanity: the fixture must actually produce every category this kind can
    // emit — including the conditional ones — or the loop below is vacuous for
    // exactly the labels most likely to be added carelessly.
    expect(nodes.length).toBeGreaterThanOrEqual(minNodes);
    expect(nodes.every((n) => typeof n.label === 'string' && n.label.length > 0)).toBe(true);
    for (const node of nodes) {
      const hit = vendorHit(node.label);
      expect(hit && `${kind}/${node.key}: "${node.label}" uses ${hit.vendor}'s "${hit.term}"`).toBeNull();
    }
  });

  it("the principal's governance bucket is labelled Business Roles and counts governance resources", () => {
    const [core, extras] = MAXIMAL_CORES.user;
    const node = getRootNodes('user', { ...core, accessPackageCount: 7 }, extras)
      .find((n) => n.key === 'access-packages');
    // Not merely "not Entra-flavoured" — it is the same wording the resource
    // graph uses for the same bucket, so the two pages read as one product.
    expect(node.label).toBe('Business Roles');
    const resourceNode = getRootNodes('resource', { accessPackageCount: 7 }, {})
      .find((n) => n.key === 'business-roles');
    expect(resourceNode.label).toBe(node.label);
    // A count of 7 (not 0/1) separates "wired to accessPackageCount" from a
    // hard-coded or truthiness-collapsed value.
    expect(node.count).toBe(7);
    expect(resourceNode.count).toBe(7);
  });
});
