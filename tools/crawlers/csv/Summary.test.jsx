// @vitest-environment jsdom
/**
 * The CSV crawler's config-card summary. It is the only place the stored
 * mapping is visible without reopening the wizard, which is one of the issue's
 * acceptance criteria ("the mapping is visible in the config").
 */
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Summary, { perFileDelimiters, mappedColumnCount } from './Summary.jsx';

const render = (cfg) => renderToStaticMarkup(h(Summary, { cfg }));

describe('perFileDelimiters', () => {
  it('is empty for a config with no per-file section — the single value is the whole truth', () => {
    expect(perFileDelimiters({ delimiter: ';' })).toEqual([]);
    expect(perFileDelimiters(null)).toEqual([]);
  });

  it('names each file and its delimiter, sorted', () => {
    expect(perFileDelimiters({
      delimiter: ';',
      files: { 'b.csv': { delimiter: '\t' }, 'a.csv': { delimiter: ',' } },
    })).toEqual(['a.csv (Comma (,))', 'b.csv (Tab)']);
  });

  it('falls back to the config delimiter for an entry that sets none', () => {
    expect(perFileDelimiters({ delimiter: '|', files: { 'a.csv': { slot: 'users' } } }))
      .toEqual(['a.csv (Pipe (|))']);
  });
});

describe('mappedColumnCount', () => {
  it('counts the mapped columns across files, ignoring empty mappings', () => {
    expect(mappedColumnCount({
      files: {
        'a.csv': { columns: { ExternalId: 'id', DisplayName: '' } },
        'b.csv': { columns: { ExternalId: 'dn' } },
        'c.csv': { slot: 'users' },
      },
    })).toBe(2);
    expect(mappedColumnCount({})).toBe(0);
  });
});

describe('Summary', () => {
  it('shows the delimiter by name, including a real tab', () => {
    expect(render({ systemName: 'AD', systemType: 'AD', delimiter: '\t' })).toContain('Tab');
    // A config stored before the fix holds the two-character "\t" form.
    expect(render({ systemName: 'AD', delimiter: '\\t' })).toContain('Tab');
    expect(render({ systemName: 'AD' })).toContain(';');
  });

  it('says nothing about mapping for an Identity Atlas-schema config', () => {
    const html = render({ systemName: 'CSV Import', delimiter: ';' });
    expect(html).not.toContain('mapped column');
    expect(html).not.toContain('Per file:');
  });

  it('shows the mapped-column count and each file\'s delimiter for a mapped config', () => {
    const html = render({
      systemName: 'AD', systemType: 'AD', delimiter: ';', sourceFormat: 'custom',
      files: { 'ad_people.csv': { slot: 'users', delimiter: ',', columns: { ExternalId: 'samaccountname', DisplayName: 'cn' } } },
    });
    expect(html).toContain('2 mapped columns');
    expect(html).toContain('ad_people.csv (Comma (,))');
  });

  it('uses the singular for exactly one mapped column', () => {
    const html = render({
      systemName: 'AD', delimiter: ';', sourceFormat: 'custom',
      files: { 'a.csv': { slot: 'users', delimiter: ';', columns: { ExternalId: 'id' } } },
    });
    expect(html).toContain('1 mapped column<');
  });
});
