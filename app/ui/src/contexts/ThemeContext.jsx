import { createContext, useContext } from 'react';

// Provides the isDark boolean to any component that needs it for inline styles.
// Tailwind dark: classes work automatically via the `dark` class on <html>;
// this context is only needed for hex-based inline styles (AP colors, tier boxes).
export const ThemeContext = createContext(false);
export const useIsDark = () => useContext(ThemeContext);
