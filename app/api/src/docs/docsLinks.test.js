// Link and anchor resolution over a made-up three-page site, so every verdict
// below is decided by the rule under test and not by the state of docs/.

import { describe, it, expect } from 'vitest';
import { linkProblem, linkTargets, measureLinks } from './docsLinks.js';

const PAGES = {
  'index.md': '# Home\n\n## Supported systems\n',
  'ref/config.md': '# Config\n\n## SMTP & mail\n\n## Tokens\n\n## Tokens\n\n## Custom { #my-id }\n',
  'ui/matrix.md': '# Matrix\n',
};
const FILES = new Set(['assets/shot.png', 'coverage/api/index.html']);
const site = {
  pages: new Set(Object.keys(PAGES)),
  exists: path => FILES.has(path),
  anchors: page => new Set({
    'index.md': ['home', 'supported-systems'],
    'ref/config.md': ['config', 'smtp-mail', 'tokens', 'tokens_1', 'my-id'],
    'ui/matrix.md': ['matrix'],
  }[page]),
};
const problem = (from, raw) => linkProblem(from, raw, site);

describe('linkTargets', () => {
  it('returns link and image targets from prose', () => {
    expect(linkTargets('See [a](a.md#x) and ![shot](../assets/s.png).')).toEqual(['a.md#x', '../assets/s.png']);
  });

  it('ignores a link inside a code fence or an inline code span', () => {
    const body = 'Write `[text](gone.md)` like this:\n```md\n[text](also-gone.md)\n```\n[real](a.md)';
    expect(linkTargets(body)).toEqual(['a.md']);
  });

  it('reads the target of a link that carries a title', () => {
    expect(linkTargets('[a](a.md#x "The title")')).toEqual(['a.md#x']);
  });
});

describe('linkProblem — anchors', () => {
  it('accepts an anchor the target page generates', () => {
    expect(problem('ui/matrix.md', '../ref/config.md#smtp-mail')).toBeNull();
  });

  it('rejects the double-hyphen form of a heading with punctuation', () => {
    // "SMTP & mail" generates #smtp-mail; #smtp--mail is the classic mistake.
    expect(problem('ui/matrix.md', '../ref/config.md#smtp--mail')).toBe('no heading generates #smtp--mail');
  });

  it('checks a same-page anchor against the page itself, not a neighbour', () => {
    expect(problem('index.md', '#supported-systems')).toBeNull();
    expect(problem('ui/matrix.md', '#supported-systems')).toBe('no heading generates #supported-systems');
  });

  it('is case-sensitive, like the browser', () => {
    expect(problem('index.md', '#Supported-Systems')).toBe('no heading generates #Supported-Systems');
  });

  it('accepts the suffixed id of a repeated heading and a custom id', () => {
    expect(problem('index.md', 'ref/config.md#tokens_1')).toBeNull();
    expect(problem('index.md', 'ref/config.md#my-id')).toBeNull();
    expect(problem('index.md', 'ref/config.md#tokens_2')).toBe('no heading generates #tokens_2');
  });

  it('accepts a link with no anchor, or an empty one', () => {
    expect(problem('index.md', 'ref/config.md')).toBeNull();
    expect(problem('index.md', 'ref/config.md#')).toBeNull();
  });

  it('does not judge anchors the site generates by itself', () => {
    expect(problem('index.md', '#fn:1')).toBeNull();
    expect(problem('index.md', '#__tabbed_1_2')).toBeNull();
  });
});

describe('linkProblem — targets', () => {
  it('skips external and site-absolute links', () => {
    expect(problem('index.md', 'https://example.com/x#nope')).toBeNull();
    expect(problem('index.md', 'mailto:someone@example.com')).toBeNull();
    expect(problem('index.md', '/IdentityAtlas/x')).toBeNull();
  });

  it('leaves a missing page to the hard broken-links gate', () => {
    expect(problem('index.md', 'gone.md')).toBeNull();
    expect(problem('index.md', 'gone.md#x')).toBeNull();
  });

  it('accepts a file that exists and rejects one that does not', () => {
    expect(problem('ui/matrix.md', '../assets/shot.png')).toBeNull();
    expect(problem('ui/matrix.md', '../assets/missing.png')).toBe('no such file');
  });

  it('resolves relative to the linking page, not the docs root', () => {
    // assets/shot.png exists at the root; from ui/ the same text points at ui/assets/.
    expect(problem('index.md', 'assets/shot.png')).toBeNull();
    expect(problem('ui/matrix.md', 'assets/shot.png')).toBe('no such file');
  });

  it('rejects a target outside docs/, however real the file is', () => {
    expect(problem('index.md', '../README.md')).toBe('points outside docs/, which the site does not publish');
    expect(problem('ui/matrix.md', '../../tools/x.ps1')).toBe('points outside docs/, which the site does not publish');
  });

  it('accepts a non-page file reached with an anchor', () => {
    expect(problem('index.md', 'coverage/api/index.html#top')).toBeNull();
  });
});

describe('measureLinks', () => {
  const exists = path => FILES.has(path);

  it('reports nothing for a healthy site', () => {
    const pages = { ...PAGES, 'ui/matrix.md': '# Matrix\n[cfg](../ref/config.md#smtp-mail) [t](../ref/config.md#tokens_1) [c](../ref/config.md#my-id)\n' };
    expect(measureLinks(Object.keys(pages), p => pages[p], exists)).toEqual({});
  });

  it('counts each broken target per page, using the real heading ids', () => {
    const pages = {
      ...PAGES,
      'ui/matrix.md': [
        '# Matrix',
        '[one](../ref/config.md#smtp--mail) and again [two](../ref/config.md#smtp--mail)',
        '[ok](../index.md#supported-systems) ![x](missing.png)',
        '```',
        '[sample](../ref/config.md#not-checked)',
        '```',
      ].join('\n'),
    };
    expect(measureLinks(Object.keys(pages), p => pages[p], exists)).toEqual({
      'ui/matrix.md': { '../ref/config.md#smtp--mail': 2, 'missing.png': 1 },
    });
  });

  it('does not take a heading inside a code fence for an anchor', () => {
    const pages = {
      'a.md': '# A\n```bash\n# install it\n```\n',
      'b.md': '[x](a.md#install-it) [y](a.md#a)',
    };
    expect(measureLinks(Object.keys(pages), p => pages[p], () => false)).toEqual({ 'b.md': { 'a.md#install-it': 1 } });
  });
});
