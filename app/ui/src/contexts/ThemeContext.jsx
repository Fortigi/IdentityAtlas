import { createContext, useContext } from 'react';

// Provides isDark boolean and mode string to components that need them for inline styles.
// Tailwind dark: classes work automatically via the `dark` class on <html>;
// this context is only needed for hex-based inline styles (AP colors, tier boxes).
export const ThemeContext = createContext({ isDark: false, mode: 'light' });

export const useIsDark = () => useContext(ThemeContext).isDark;
export const useThemeMode = () => useContext(ThemeContext).mode;
