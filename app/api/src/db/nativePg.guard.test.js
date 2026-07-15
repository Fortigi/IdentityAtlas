// Hard guard: the API talks to Postgres through ONE native surface.
//
// #663 removed the MSSQL compatibility shim — `getPool().request().input(name,
// val).query()` returning `{ recordset }`, with `@name` placeholders rewritten
// to `$N`. Every query is now native pg (`db.query` / `timedQuery` /
// `pool.query`) with positional `$N` params, reading `.rows`. This static scan
// fails the build if the shim — or a second, ungoverned pg pool — creeps back.
//
//   Tier 1 — no shim / T-SQL surface in production code: timedRequest,
//     makeCompatRequest, replaceAtParams, splitSqlStatements, `.request(`,
//     `.input(`, `.recordset(s)`, `.rowsAffected`, and `@name` SQL params.
//   Tier 2 — only db/connection.js (and the standalone auth CLI) may import
//     `pg` or construct a Pool, so the pool stays a single governed surface.
//   Tier 3 — no PowerShell script talks to the database with a SQL Server
//     client. Tiers 1-2 only cover `app/api/src`, so they could never see the
//     *other* T-SQL surface: test scripts that bypass the API and open their
//     own `System.Data.SqlClient` connection straight to the DB. Those kept
//     working against v4 SQL Server long after the v5 postgres port and rotted
//     unnoticed (#707) — nothing imports them, so no JS guard could catch it.
//
// Test files are deliberately NOT scanned by Tiers 1-2: a few legitimately mock
// the old `{ recordset }` shape to prove native callers still read it during the
// transition. Comment lines are skipped so the JSDoc `@param`/`@returns` tags
// and this file's own explanatory prose don't trip the scan.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(SRC, '..', '..', '..');

function walk(dir, keep) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') out.push(...walk(p, keep)); }
    else if (keep(name)) out.push(p);
  }
  return out;
}
const FILES = walk(SRC, (n) => /\.(js|jsx)$/.test(n) && !/\.test\./.test(n));
// Every directory in the repo that holds PowerShell.
const PS_FILES = ['test', 'tools'].flatMap((r) => walk(join(REPO_ROOT, r), (n) => /\.psm?1$/.test(n)));

// The ban is about live code, not the prose that documents the migration away
// from the shim — this very file, and PgQuery.psm1's header, name the banned
// tokens in order to explain them. Each stripper blanks comments while keeping
// one output line per input line, so reported line numbers stay accurate.

// Skip single-line and block-comment lines.
const isComment = (line) => {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
};
const stripJs = (text) => text.split('\n').map((l) => (isComment(l) ? '' : l));

// PowerShell has `#` to end-of-line and `<# ... #>` blocks. Comment-based help
// (the .SYNOPSIS header every script here opens with) is a block comment, so a
// line-at-a-time test can't see it — this tracks block state.
const stripPs = (text) => {
  const out = [];
  let inBlock = false;
  for (const line of text.split('\n')) {
    let l = line;
    if (inBlock) {
      const close = l.indexOf('#>');
      if (close === -1) { out.push(''); continue; }
      l = l.slice(close + 2);
      inBlock = false;
    }
    const open = l.indexOf('<#');
    if (open !== -1) {
      const close = l.indexOf('#>', open + 2);
      if (close === -1) { inBlock = true; out.push(l.slice(0, open)); continue; }
      l = l.slice(0, open) + l.slice(close + 2);
    }
    const hash = l.indexOf('#');
    out.push(hash === -1 ? l : l.slice(0, hash));
  }
  return out;
};

function scan(re, { files = FILES, relTo = SRC, strip = stripJs, allow = new Set() } = {}) {
  const offenders = [];
  for (const f of files) {
    const r = relative(relTo, f).replace(/\\/g, '/');
    if (allow.has(r)) continue;
    strip(readFileSync(f, 'utf8')).forEach((line, i) => {
      if (re.test(line)) offenders.push(`${r}:${i + 1}  ${line.trim()}`);
    });
  }
  return offenders;
}

describe('native-pg guard — no MSSQL shim / T-SQL surface (Tier 1)', () => {
  const BANNED = [
    { name: 'timedRequest',       re: /\btimedRequest\b/ },
    { name: 'makeCompatRequest',  re: /\bmakeCompatRequest\b/ },
    { name: 'replaceAtParams',    re: /\breplaceAtParams\b/ },
    { name: 'splitSqlStatements', re: /\bsplitSqlStatements\b/ },
    { name: '.recordset(s)',      re: /\.recordsets?\b/ },
    { name: '.rowsAffected',      re: /\.rowsAffected\b/ },
    { name: '.request(',          re: /\.request\(/ },
    { name: '.input(',            re: /\.input\(/ },
  ];

  for (const { name, re } of BANNED) {
    it(`no production file uses the shim surface: ${name}`, () => {
      const offenders = scan(re);
      expect(offenders, `${name} reintroduced:\n${offenders.join('\n')}`).toEqual([]);
    });
  }

  it('no production SQL uses a T-SQL @name placeholder', () => {
    // A T-SQL param is `@word` preceded by `=`, `(`, `,`, or whitespace, inside a
    // SQL string. Comment lines (JSDoc @param/@returns, @asof design notes) skip.
    const offenders = scan(/[=(,\s]@[A-Za-z_]\w*/);
    expect(offenders, `T-SQL @name param reintroduced:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('single pg surface — only connection.js owns the pool (Tier 2)', () => {
  // db/connection.js is the one governed pool. cli/auth-config.js is a standalone
  // short-lived process (invoked via `docker exec`) that cannot share it.
  const ALLOW = new Set(['db/connection.js', 'cli/auth-config.js']);

  it('no other file imports pg or constructs a Pool', () => {
    const offenders = scan(/\bnew Pool\b|from ['"]pg['"]|require\(['"]pg['"]\)/, { allow: ALLOW });
    expect(offenders, `pg/Pool used outside the governed surface:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('no SQL Server client in PowerShell (Tier 3)', () => {
  // PowerShell reaches postgres through test/lib/PgQuery.psm1 (psql over `docker
  // compose exec`) — never a SQL Server driver, and never v4 T-SQL.
  //
  // Each pattern below is a *SQL-Server-only* token, chosen so it cannot collide
  // with legitimate data. Notably we do NOT ban the bare word `ValidTo`: Omada
  // genuinely carries validFrom/validTo fields in its own source records
  // (OmadaCrawler.Transform.ps1 maps them into extendedAttributes), and those are
  // unrelated to the v4 temporal column this repo dropped. The dead giveaway of a
  // temporal *predicate* is the sentinel value, so that is what we match.
  const BANNED_PS = [
    { name: 'System.Data.SqlClient (MSSQL driver)', re: /\b(?:System|Microsoft)\.Data\.SqlClient\b/ },
    { name: 'SqlConnection / SqlCommand / SqlDataAdapter', re: /\bSql(?:Connection|Command|DataAdapter)\b/ },
    { name: 'TrustServerCertificate (MSSQL conn string)', re: /\bTrustServerCertificate\b/ },
    { name: 'dbo. schema prefix (T-SQL)', re: /\bdbo\./ },
    { name: 'v4 temporal sentinel (ValidTo = 9999-12-31…)', re: /9999-12-31[ T]23:59:59/ },
  ];

  it('finds PowerShell to scan', () => {
    // A silent zero here would make every assertion below vacuously pass.
    expect(PS_FILES.length).toBeGreaterThan(20);
  });

  // stripPs is what stops this guard flagging the prose that explains it. If it
  // over-reached it would quietly blank real code and the scan would pass by
  // seeing nothing — so pin both directions.
  describe('stripPs', () => {
    const banned = /\bSql(?:Connection|Command|DataAdapter)\b/;

    it('blanks <# .. #> block comments (comment-based help)', () => {
      const lines = stripPs('<#\n  Do not use SqlConnection here.\n#>\n$x = 1');
      expect(lines.some((l) => banned.test(l))).toBe(false);
      expect(lines).toHaveLength(4);
    });

    it('blanks # line comments', () => {
      expect(stripPs('# uses SqlConnection, historically').some((l) => banned.test(l))).toBe(false);
    });

    it('still sees real code after a block comment closes', () => {
      const lines = stripPs('<#\n help\n#>\n$c = New-Object System.Data.SqlClient.SqlConnection($s)');
      expect(lines.some((l) => banned.test(l))).toBe(true);
    });

    it('still sees real code on a line with a trailing comment', () => {
      expect(stripPs('$c = [SqlConnection]::new()  # legacy').some((l) => banned.test(l))).toBe(true);
    });

    it('keeps line numbers aligned with the source', () => {
      const src = '$a = 1\n<#\n c\n#>\n$b = SqlConnection';
      const lines = stripPs(src);
      expect(lines).toHaveLength(5);
      expect(banned.test(lines[4])).toBe(true);
    });
  });

  for (const { name, re } of BANNED_PS) {
    it(`no .ps1/.psm1 uses: ${name}`, () => {
      const offenders = scan(re, { files: PS_FILES, relTo: REPO_ROOT, strip: stripPs });
      expect(offenders, `SQL Server / T-SQL surface in PowerShell:\n${offenders.join('\n')}`).toEqual([]);
    });
  }
});
