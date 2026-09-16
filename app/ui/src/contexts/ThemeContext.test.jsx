// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

afterEach(cleanup);
import { ThemeContext, useIsDark, useThemeMode } from './ThemeContext';

// A probe that reads both hooks so their bodies execute deterministically,
// rather than relying on incidental coverage from whichever components happen
// to import the module.
function Probe() {
  const isDark = useIsDark();
  const mode = useThemeMode();
  return <div data-testid="probe">{String(isDark)}:{mode}</div>;
}

describe('ThemeContext hooks', () => {
  it('read the provided context value', () => {
    render(
      <ThemeContext.Provider value={{ isDark: true, mode: 'dark' }}>
        <Probe />
      </ThemeContext.Provider>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('true:dark');
  });

  it('fall back to the light default when no provider wraps the tree', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('false:light');
  });
});
