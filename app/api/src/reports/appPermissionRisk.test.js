// The shortlist is a table; what matters is that it is applied on the API's
// appId and the exact permission value, and on nothing looser. Each case here
// is chosen so that a plausible shortcut — matching on the value alone, on the
// API's name, or on a prefix — gives a different answer.

import { describe, it, expect } from 'vitest';
import {
  classifyAppPermission, HIGH_RISK_APIS, SEVERITY,
  isStandardPermission, knownApiName, parsePermissionKey, permissionKey,
} from './appPermissionRisk.js';

const GRAPH = '00000003-0000-0000-c000-000000000000';
const SPO = '00000003-0000-0ff1-ce00-000000000000';
const EXO = '00000002-0000-0ff1-ce00-000000000000';

describe('permission keys', () => {
  it('round-trips an (API, permission) pair, with the appId lower-cased', () => {
    const key = permissionKey(GRAPH.toUpperCase(), 'User.Read.All');
    expect(key).toBe(`${GRAPH}|User.Read.All`);
    expect(parsePermissionKey(key)).toEqual({ apiAppId: GRAPH, permission: 'User.Read.All' });
  });

  it('keeps everything after the first separator as the permission', () => {
    expect(parsePermissionKey(`${GRAPH}|a|b`)).toEqual({ apiAppId: GRAPH, permission: 'a|b' });
  });

  it('trims stray whitespace around either part', () => {
    expect(parsePermissionKey(` ${GRAPH} | Mail.Read `)).toEqual({ apiAppId: GRAPH, permission: 'Mail.Read' });
  });

  it('rejects anything that does not name an API by appId and a permission', () => {
    for (const bad of ['Mail.Read', 'graph|Mail.Read', `${GRAPH}|`, `${GRAPH}|   `, '|Mail.Read', '', null, undefined]) {
      expect(parsePermissionKey(bad), String(bad)).toBeNull();
    }
  });
});

describe('knownApiName', () => {
  it('names a listed API whatever the appId\'s case, and nothing else', () => {
    expect(knownApiName(GRAPH.toUpperCase())).toBe('Microsoft Graph');
    expect(knownApiName(SPO)).toBe('Office 365 SharePoint Online');
    expect(knownApiName('11111111-2222-3333-4444-555555555555')).toBeNull();
    expect(knownApiName(null)).toBeNull();
  });
});

describe('classifyAppPermission', () => {
  it('classifies a shortlisted Microsoft Graph permission with its category and severity', () => {
    expect(classifyAppPermission({ targetApiAppId: GRAPH, permission: 'Mail.Read' }))
      .toEqual({ api: 'Microsoft Graph', category: 'Mailboxes', severity: 'High' });
    expect(classifyAppPermission({ targetApiAppId: GRAPH, permission: 'Sites.ReadWrite.All' }))
      .toEqual({ api: 'Microsoft Graph', category: 'SharePoint and OneDrive content', severity: 'Critical' });
    expect(classifyAppPermission({ targetApiAppId: GRAPH, permission: 'RoleManagement.ReadWrite.Directory' }))
      .toEqual({ api: 'Microsoft Graph', category: 'Directory control', severity: 'Critical' });
  });

  it('tells read from write by severity, not by category', () => {
    const read = classifyAppPermission({ targetApiAppId: GRAPH, permission: 'Files.Read.All' });
    const write = classifyAppPermission({ targetApiAppId: GRAPH, permission: 'Files.ReadWrite.All' });
    expect(read.category).toBe(write.category);
    expect(read.severity).toBe('High');
    expect(write.severity).toBe('Critical');
  });

  it('does not classify a same-named permission on an API that is not listed', () => {
    // A third-party API may publish an app role called Mail.Read; it does not
    // read Exchange mailboxes, and must not be reported as Microsoft Graph.
    expect(classifyAppPermission({ targetApiAppId: '11111111-2222-3333-4444-555555555555', permission: 'Mail.Read' })).toBeNull();
  });

  it('does not classify a listed API\'s permission that is not on its shortlist', () => {
    expect(classifyAppPermission({ targetApiAppId: GRAPH, permission: 'User.Read' })).toBeNull();
    expect(classifyAppPermission({ targetApiAppId: GRAPH, permission: 'User.Read.All' })).toBeNull();
    // Exchange Online does not publish Mail.Read; only Graph's one is listed.
    expect(classifyAppPermission({ targetApiAppId: EXO, permission: 'Mail.Read' })).toBeNull();
  });

  it('matches the permission value exactly — no prefix, no case folding', () => {
    expect(classifyAppPermission({ targetApiAppId: GRAPH, permission: 'Mail.ReadBasic' })).toBeNull();
    expect(classifyAppPermission({ targetApiAppId: GRAPH, permission: 'mail.read' })).toBeNull();
    expect(classifyAppPermission({ targetApiAppId: GRAPH, permission: 'Sites.Read.All ' })).toBeNull();
  });

  it('matches the API appId case-insensitively (Graph returns it lower-case; a hand-typed one may not be)', () => {
    expect(classifyAppPermission({ targetApiAppId: GRAPH.toUpperCase(), permission: 'Mail.Send' })?.api).toBe('Microsoft Graph');
  });

  it('names the API from the shortlist, so SharePoint Online and Graph site roles stay apart', () => {
    expect(classifyAppPermission({ targetApiAppId: SPO, permission: 'Sites.FullControl.All' }).api).toBe('Office 365 SharePoint Online');
    expect(classifyAppPermission({ targetApiAppId: GRAPH, permission: 'Sites.FullControl.All' }).api).toBe('Microsoft Graph');
    expect(classifyAppPermission({ targetApiAppId: EXO, permission: 'full_access_as_app' }))
      .toEqual({ api: 'Office 365 Exchange Online', category: 'Mailboxes', severity: 'Critical' });
  });

  it('returns null, not a throw, when the target API or the permission is unknown', () => {
    expect(classifyAppPermission({ targetApiAppId: null, permission: 'Mail.Read' })).toBeNull();
    expect(classifyAppPermission({ targetApiAppId: undefined, permission: 'Mail.Read' })).toBeNull();
    expect(classifyAppPermission({ targetApiAppId: GRAPH, permission: null })).toBeNull();
    expect(classifyAppPermission({ targetApiAppId: GRAPH, permission: '' })).toBeNull();
    // An appRoleId the crawler could not resolve to a value falls through as the guid.
    expect(classifyAppPermission({ targetApiAppId: GRAPH, permission: 'e2a3a72e-5f79-4c64-b1b1-878b674786c9' })).toBeNull();
  });

  it('keeps the table well-formed: lower-case appIds, a name per API, a category and a known severity per permission', () => {
    const severities = new Set(Object.values(SEVERITY));
    for (const [appId, api] of Object.entries(HIGH_RISK_APIS)) {
      expect(appId).toBe(appId.toLowerCase());
      expect(appId).toMatch(/^[0-9a-f-]{36}$/);
      expect(api.name.length).toBeGreaterThan(0);
      expect(Object.keys(api.permissions).length).toBeGreaterThan(0);
      for (const [value, entry] of Object.entries(api.permissions)) {
        expect(value, `${api.name} ${value}`).toBe(value.trim());
        expect(entry.category.length).toBeGreaterThan(0);
        expect(severities.has(entry.severity), `${api.name} ${value}`).toBe(true);
      }
    }
  });

  it('is what isStandardPermission answers', () => {
    expect(isStandardPermission(GRAPH, 'Mail.Read')).toBe(true);
    expect(isStandardPermission(GRAPH, 'User.Read.All')).toBe(false);
  });

  it('covers the agreed first shortlist on Microsoft Graph', () => {
    const graph = Object.keys(HIGH_RISK_APIS[GRAPH].permissions);
    for (const p of [
      'Sites.Read.All', 'Sites.ReadWrite.All', 'Sites.FullControl.All', 'Files.Read.All', 'Files.ReadWrite.All',
      'Mail.Read', 'Mail.ReadWrite', 'Mail.Send',
      'Directory.ReadWrite.All', 'RoleManagement.ReadWrite.Directory', 'AppRoleAssignment.ReadWrite.All', 'Application.ReadWrite.All',
    ]) expect(graph, p).toContain(p);
  });
});
