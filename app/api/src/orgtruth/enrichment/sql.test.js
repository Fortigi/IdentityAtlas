// SQL-text tests only: what the rows MEAN against a real schema was checked on
// PostgreSQL (PGlite with every migration + 088) while writing this; the unit
// mocks cannot see it.
import { describe, it, expect } from 'vitest';
import { enrichmentTargetsSql, attributeValuesSql } from './sql.js';

describe('enrichmentTargetsSql', () => {
  const sql = enrichmentTargetsSql();

  it('reads accepted, current rows of enrichment profiles only', () => {
    expect(sql).toMatch(/JOIN "OrgImportProfiles" p ON p\."id" = e\."profileId" AND p\."template" = 'enrichment'/);
    expect(sql).toMatch(/WHERE e\."status" = 'accepted' AND e\."validTo" IS NULL$/);
  });

  it('follows only accepted links to the profile\'s target type, through the via of its first rule to that type', () => {
    expect(sql).toMatch(/l\."status" = 'accepted'\s+AND l\."targetType" = p\."recipe"->'enrich'->>'targetType'/);
    expect(sql).toMatch(/WHERE kr\.r->>'targetType' = p\."recipe"->'enrich'->>'targetType'\s+ORDER BY kr\.n LIMIT 1/);
    // no key rule → any via of a link to the target type
    expect(sql).toMatch(/COALESCE\(l\."via", 'displayName'\) = COALESCE\(\(SELECT kr\.r->>'via'[\s\S]*\), COALESCE\(l\."via", 'displayName'\)\)/);
  });

  it('ANDs extra conditions on, one per line', () => {
    const s = enrichmentTargetsSql(['e."entityType" = $1', 'l."targetId" = ANY($2::uuid[])']);
    expect(s).toMatch(/e\."validTo" IS NULL\n\s+AND e\."entityType" = \$1\n\s+AND l\."targetId" = ANY\(\$2::uuid\[\]\)$/);
  });
});

describe('attributeValuesSql', () => {
  it('unnests an array value and wraps a scalar, with the key bound as text', () => {
    expect(attributeValuesSql('e', '$3')).toBe(
      `jsonb_array_elements_text(CASE jsonb_typeof(e."attributes"->($3::text)) WHEN 'array' THEN e."attributes"->($3::text) ELSE jsonb_build_array(e."attributes"->>($3::text)) END)`,
    );
  });
});
