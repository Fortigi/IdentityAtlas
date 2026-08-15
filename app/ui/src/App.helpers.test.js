import { describe, it, expect } from 'vitest';
import {
  DETAIL_PREFIXES,
  isDetailPage,
  parseDetailRoute,
  pickDisplayName,
  closeFallbackPage,
  detailTabIconBg,
} from './App.helpers';

describe('isDetailPage', () => {
  it('is true for every detail prefix', () => {
    for (const prefix of DETAIL_PREFIXES) {
      expect(isDetailPage(`${prefix}:abc`)).toBe(true);
    }
  });

  it('is false for static page keys and bare prefixes without a colon', () => {
    expect(isDetailPage('dashboard')).toBe(false);
    expect(isDetailPage('principals')).toBe(false);
    expect(isDetailPage('matrix')).toBe(false);
    expect(isDetailPage('user')).toBe(false); // no colon
  });
});

describe('parseDetailRoute', () => {
  it('splits type/id on the first colon', () => {
    expect(parseDetailRoute('user:123')).toEqual({ type: 'user', id: '123' });
    expect(parseDetailRoute('access-package:ap-9')).toEqual({ type: 'access-package', id: 'ap-9' });
  });

  it('keeps colons inside the id', () => {
    expect(parseDetailRoute('resource:a:b:c')).toEqual({ type: 'resource', id: 'a:b:c' });
  });

  it('returns null for non-detail pages', () => {
    expect(parseDetailRoute('dashboard')).toBeNull();
    expect(parseDetailRoute('matrix')).toBeNull();
  });
});

describe('pickDisplayName', () => {
  it('reads each supported payload shape', () => {
    expect(pickDisplayName({ identity: { displayName: 'Ada' } })).toBe('Ada');
    expect(pickDisplayName({ core: { attributes: { displayName: 'Grp' } } })).toBe('Grp');
    expect(pickDisplayName({ core: { displayName: 'Usr' } })).toBe('Usr');
    expect(pickDisplayName({ attributes: { displayName: 'Attr' } })).toBe('Attr');
    expect(pickDisplayName({ displayName: 'Flat' })).toBe('Flat');
  });

  it('returns null when no shape matches or input is nullish', () => {
    expect(pickDisplayName({})).toBeNull();
    expect(pickDisplayName(null)).toBeNull();
    expect(pickDisplayName(undefined)).toBeNull();
  });
});

describe('closeFallbackPage', () => {
  it('maps types with a dedicated landing page', () => {
    expect(closeFallbackPage('run')).toBe('contexts');
    expect(closeFallbackPage('department')).toBe('contexts');
    expect(closeFallbackPage('context')).toBe('contexts');
    expect(closeFallbackPage('identity')).toBe('identities');
    expect(closeFallbackPage('resource')).toBe('resources');
  });

  it('falls back to the matrix for everything else', () => {
    expect(closeFallbackPage('user')).toBe('matrix');
    expect(closeFallbackPage('group')).toBe('matrix');
    expect(closeFallbackPage('access-package')).toBe('matrix');
  });
});

describe('detailTabIconBg', () => {
  it('gives user/resource/group/department/context their own tint', () => {
    expect(detailTabIconBg('user')).toContain('blue');
    expect(detailTabIconBg('resource')).toContain('purple');
    expect(detailTabIconBg('group')).toContain('purple');
    expect(detailTabIconBg('department')).toContain('green');
    expect(detailTabIconBg('context')).toContain('sky');
  });

  it('falls back to indigo for identity / run / unknown types', () => {
    expect(detailTabIconBg('identity')).toContain('indigo');
    expect(detailTabIconBg('run')).toContain('indigo');
    expect(detailTabIconBg('access-package')).toContain('indigo');
  });
});
