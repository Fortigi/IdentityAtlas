// Guard: the published first-install commands actually start the stack.
//
// docker-compose.prod.yml refuses to start while POSTGRES_PASSWORD is unset or
// empty (deliberately — it ships no default password). For a while every public
// install path left it empty anyway: the landing page and CLAUDE.md ran `up`
// with no .env at all, and the README copied a template whose password is blank
// and called the defaults fine. A stranger pasting any of them got an error.
//
// Nothing in CI starts the production compose file, so this scans the pages
// instead: every code block that downloads the compose file and starts it must
// first write a generated POSTGRES_PASSWORD to .env, without replacing a .env
// that is already there (the database keeps the password it was created with,
// so a fresh password on a second run locks the app out of its own database).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT, listPages } from './docsStructure.js';

const read = (file) => readFileSync(join(REPO_ROOT, file), 'utf8');

const COMPOSE = 'docker-compose.prod.yml';
const DOWNLOAD = `raw.githubusercontent.com/Fortigi/IdentityAtlas/main/${COMPOSE}`;
const UP = /docker compose -f docker-compose\.prod\.yml up\b/;
const BASH_PASSWORD_STEP = '[ -f .env ] || echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > .env';

// ── Pulling the code blocks out of each kind of file ─────────────────────────

/** Fenced code blocks of a markdown file (fences may be indented inside tabs). */
function markdownBlocks(text) {
  const blocks = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const isFence = /^\s*```/.test(line);
    if (isFence && current === null) { current = []; continue; }
    if (isFence) { blocks.push(current.join('\n')); current = null; continue; }
    if (current !== null) current.push(line);
  }
  return blocks;
}

/** Text content of an HTML fragment: everything outside `<…>` tags. */
function textOutsideTags(html) {
  let out = '';
  let inTag = false;
  for (const ch of html) {
    if (ch === '<') inTag = true;
    else if (ch === '>' && inTag) inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

/** <pre> blocks of an HTML page, as the text a visitor would copy. */
function htmlBlocks(text) {
  const entities = { '&gt;': '>', '&lt;': '<', '&quot;': '"', '&#39;': "'", '&amp;': '&' };
  return [...text.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map(([, inner]) =>
    textOutsideTags(inner).replace(/&(gt|lt|quot|#39|amp);/g, (e) => entities[e]));
}

/** The comment header of a YAML file, uncommented — it carries a quick start too. */
function yamlHeaderBlocks(text) {
  const header = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('#')) break;
    header.push(line.replace(/^#\s?/, ''));
  }
  return [header.join('\n')];
}

function blocksOf(file) {
  const text = read(file);
  if (file.endsWith('.html')) return htmlBlocks(text);
  if (file.endsWith('.yml')) return yamlHeaderBlocks(text);
  return markdownBlocks(text);
}

// ── The rule ─────────────────────────────────────────────────────────────────

/** Commands of a block: comment lines dropped, so a commented-out step does not count. */
const commands = (block) =>
  block.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));

/** A first-install block downloads the compose file and starts it. */
const isInstallBlock = (block) => {
  const lines = commands(block);
  return lines.some((line) => line.includes(DOWNLOAD)) && lines.some((line) => UP.test(line));
};

/** Why a first-install block would not give a stranger a running stack. Empty = fine. */
function installProblems(block) {
  const lines = commands(block);
  const up = lines.findIndex((line) => UP.test(line));
  // A generated value (command substitution), written to .env — not a blank or a placeholder.
  const write = lines.findIndex((line) => /POSTGRES_PASSWORD=\$\(.+\)/.test(line) && /\.env\b/.test(line));
  if (write === -1) return ['never writes a generated POSTGRES_PASSWORD to .env'];
  const problems = [];
  if (write > up) problems.push('starts the stack before POSTGRES_PASSWORD is written');
  const keepsExisting = lines
    .slice(0, write + 1)
    .some((line) => line.startsWith('[ -f .env ] ||') || line.startsWith('if (-not (Test-Path .env))'));
  if (!keepsExisting) problems.push('overwrites an existing .env, which changes the password of a database that already exists');
  return problems;
}

const installBlocks = (file) => blocksOf(file).filter(isInstallBlock);

// ── The rule itself, on inputs where the answer is known ─────────────────────

describe('installProblems', () => {
  const download = `curl -O https://${DOWNLOAD}`;
  const up = 'docker compose -f docker-compose.prod.yml up -d --pull always';

  it('accepts the bash quick start', () => {
    expect(installProblems([download, BASH_PASSWORD_STEP, up].join('\n'))).toEqual([]);
  });

  it('accepts the PowerShell quick start', () => {
    const block = [
      `Invoke-WebRequest -Uri https://${DOWNLOAD} -OutFile docker-compose.prod.yml`,
      'if (-not (Test-Path .env)) {',
      '    $bytes = [byte[]]::new(24)',
      '    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)',
      '    "POSTGRES_PASSWORD=$(-join ($bytes | ForEach-Object { $_.ToString(\'x2\') }))" | Set-Content .env -Encoding ascii',
      '}',
      up,
    ].join('\n');
    expect(installProblems(block)).toEqual([]);
  });

  it('rejects the landing-page snippet that shipped: download, then up', () => {
    expect(installProblems([download, up].join('\n'))).toEqual(['never writes a generated POSTGRES_PASSWORD to .env']);
  });

  it('rejects the README that shipped: a blank template and a placeholder in a comment', () => {
    const block = [
      download,
      'curl -O https://raw.githubusercontent.com/Fortigi/IdentityAtlas/main/setup/config/.env.example',
      'cp .env.example .env',
      '# For a quick local evaluation the defaults are fine.',
      '#   POSTGRES_PASSWORD=<strong-password>',
      up,
    ].join('\n');
    expect(installProblems(block)).toEqual(['never writes a generated POSTGRES_PASSWORD to .env']);
  });

  it('does not count a password step that is commented out', () => {
    expect(installProblems([download, `# ${BASH_PASSWORD_STEP}`, up].join('\n')))
      .toEqual(['never writes a generated POSTGRES_PASSWORD to .env']);
  });

  it('does not count a blank or literal password', () => {
    for (const step of ['echo "POSTGRES_PASSWORD=" > .env', 'echo "POSTGRES_PASSWORD=changeme" > .env']) {
      expect(installProblems([download, step, up].join('\n')), step)
        .toEqual(['never writes a generated POSTGRES_PASSWORD to .env']);
    }
  });

  it('rejects a password written after the stack has started', () => {
    expect(installProblems([download, up, BASH_PASSWORD_STEP].join('\n')))
      .toEqual(['starts the stack before POSTGRES_PASSWORD is written']);
  });

  it('rejects a step that replaces an existing .env', () => {
    const clobber = 'echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > .env';
    expect(installProblems([download, clobber, up].join('\n')))
      .toEqual(['overwrites an existing .env, which changes the password of a database that already exists']);
  });
});

describe('htmlBlocks', () => {
  it('returns the copied text of a <pre>: tags dropped, entities decoded', () => {
    const html = '<p>x</p><pre><code id="s"><span class="a">echo</span> "a" &gt; .env &amp;&amp; b</code></pre>';
    expect(htmlBlocks(html)).toEqual(['echo "a" > .env && b']);
  });
});

describe('isInstallBlock', () => {
  it('leaves upgrade commands alone: they start an install that already has its .env', () => {
    expect(isInstallBlock('docker compose -f docker-compose.prod.yml up -d --pull always')).toBe(false);
  });

  it('ignores a block that only mentions the download in a comment', () => {
    expect(isInstallBlock(`# curl -O https://${DOWNLOAD}\ndocker compose -f docker-compose.prod.yml up -d`)).toBe(false);
  });
});

// ── The real pages ───────────────────────────────────────────────────────────

describe('published install commands', () => {
  // Everywhere a newcomer (or an assistant reading CLAUDE.md) is told how to install.
  const SOURCES = [
    'README.md',
    'CLAUDE.md',
    'site/index.html',
    COMPOSE,
    ...listPages().map((page) => `docs/${page}`),
  ];

  it('the production compose file still requires POSTGRES_PASSWORD', () => {
    // The premise of this guard. `:?` fails on unset AND empty; the message must
    // not contain `}` or `$`, which would end or restart the interpolation.
    const compose = read(COMPOSE);
    expect(compose).toMatch(/"\$\{POSTGRES_PASSWORD:\?[^}$"]+\}"/);
    expect(compose).not.toMatch(/\$\{POSTGRES_PASSWORD:?-/);
  });

  it('every first-install block sets a database password before it starts the stack', () => {
    const failures = [];
    for (const file of SOURCES) {
      for (const block of installBlocks(file)) {
        for (const problem of installProblems(block)) failures.push(`${file}: ${problem}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('finds the install block on each page a newcomer lands on', () => {
    // Without this the check above passes on a page whose block it failed to parse.
    const count = (file) => installBlocks(file).length;
    expect({
      readme: count('README.md'),
      claudeMd: count('CLAUDE.md'),
      landingPage: count('site/index.html'),
      composeHeader: count(COMPOSE),
    }).toEqual({ readme: 1, claudeMd: 1, landingPage: 1, composeHeader: 1 });
  });

  it.each(['docs/quickstart.md', 'docs/architecture/docker-setup.md'])(
    '%s gives the install commands for bash and for PowerShell',
    (file) => {
      const blocks = installBlocks(file);
      expect(blocks.filter((block) => block.includes('curl -O'))).toHaveLength(1);
      expect(blocks.filter((block) => block.includes('Invoke-WebRequest'))).toHaveLength(1);
    },
  );

  it('the landing page snippet copies as the working bash command', () => {
    // The page wraps the command in highlighting spans and escapes `>`; what the
    // Copy button hands over is the text, and that is what has to run.
    const [snippet] = installBlocks('site/index.html');
    expect(commands(snippet)).toEqual([
      `curl -O https://${DOWNLOAD}`,
      BASH_PASSWORD_STEP,
      'docker compose -f docker-compose.prod.yml up -d --pull always',
    ]);
  });
});

describe('landing page authentication claim', () => {
  it('only promises enforced sign-in for the deployment that enforces it', () => {
    // The Docker stack starts in open mode; only the Azure template turns sign-in
    // on from the first deploy. If this default ever flips, revisit the wording.
    expect(read(COMPOSE)).toContain('AUTH_ENABLED: "${AUTH_ENABLED:-false}"');

    // `<p>` or `<p attr…>` only — a bare `<p[^>]*>` also matches `<path …>` in the icons.
    const paragraphs = [...read('site/index.html').matchAll(/<p(?:>|\s[^>]*>)([\s\S]*?)<\/p>/g)].map(([, inner]) => inner);
    const claims = paragraphs.filter((p) => /SSO is enforced|enforces Entra SSO|anonymous access/i.test(p));
    // Two today: the "Deploy to Azure" card and the trust item.
    expect(claims.length).toBeGreaterThanOrEqual(2);
    for (const claim of claims) expect(claim).toContain('Azure');
  });
});
