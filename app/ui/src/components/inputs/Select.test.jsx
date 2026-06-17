import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import Select from './Select';

const render = (props, children) =>
  renderToStaticMarkup(h(Select, { onChange: () => {}, ...props }, children));

describe('Select', () => {
  it('renders without throwing', () => {
    expect(() => render({ value: '' })).not.toThrow();
  });

  it('hides the native browser arrow (appearance-none)', () => {
    expect(render({ value: '' })).toContain('appearance-none');
  });

  it('renders children as <option> elements', () => {
    const html = render(
      { value: 'b' },
      [h('option', { key: 'a', value: 'a' }, 'Alpha'), h('option', { key: 'b', value: 'b' }, 'Beta')]
    );
    expect(html).toContain('<option');
    expect(html).toContain('Alpha');
    expect(html).toContain('Beta');
  });

  it('applies wrapperClassName to the outer div', () => {
    expect(render({ value: '', wrapperClassName: 'flex-1 min-w-0' })).toContain('flex-1 min-w-0');
  });

  it('renders the ChevronDown SVG overlay', () => {
    expect(render({ value: '' })).toContain('<svg');
    expect(render({ value: '' })).toContain('pointer-events-none');
  });

  it('passes the id prop to the underlying select', () => {
    expect(render({ value: '', id: 'my-select' })).toContain('id="my-select"');
  });
});
