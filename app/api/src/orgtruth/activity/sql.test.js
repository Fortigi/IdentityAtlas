import { describe, it, expect } from 'vitest';
import { activityRollupSql, round2, later, earlier } from './sql.js';

describe('activityRollupSql', () => {
  it('only accepted keys resolve; unresolved rows still roll up (LEFT JOIN)', () => {
    const sql = activityRollupSql('sk."targetId" = $1');
    expect(sql).toMatch(/LEFT JOIN "OrgActivityKeys" sk ON sk\."id" = a\."subjectKeyId" AND sk\."status" = 'accepted'/);
    expect(sql).toMatch(/LEFT JOIN "OrgActivityKeys" ak ON ak\."id" = a\."actorKeyId" AND ak\."status" = 'accepted'/);
    expect(sql).toMatch(/WHERE sk\."targetId" = \$1\n\s+GROUP BY 1, 3, 4, 5, 6, 7, 8, 9$/);
  });

  it('dates leave as text; the month only when asked', () => {
    expect(activityRollupSql('true')).toMatch(/NULL::text AS month/);
    expect(activityRollupSql('true', { byMonth: true })).toMatch(/to_char\(a\."occurredOn", 'YYYY-MM'\) AS month/);
    expect(activityRollupSql('true')).toMatch(/to_char\(MAX\(a\."occurredOn"\), 'YYYY-MM-DD'\) AS "lastOn"/);
  });
});

describe('helpers', () => {
  it('round2 rounds to cents, from a numeric string too', () => {
    expect(round2(8123.456)).toBe(8123.46);
    expect(round2('2.004')).toBe(2);
  });

  it('later / earlier ignore a missing side', () => {
    expect(later(null, '2026-01-01')).toBe('2026-01-01');
    expect(later('2026-02-01', '2026-01-01')).toBe('2026-02-01');
    expect(later('2026-02-01', null)).toBe('2026-02-01');
    expect(earlier(null, '2026-01-01')).toBe('2026-01-01');
    expect(earlier('2026-02-01', '2026-01-01')).toBe('2026-01-01');
    expect(earlier('2026-01-01', '2026-02-01')).toBe('2026-01-01');
    expect(earlier('2026-01-01', null)).toBe('2026-01-01');
  });
});
