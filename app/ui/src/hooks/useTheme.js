import { useState, useEffect } from 'react';

const MODES = ['light', 'auto', 'dark'];

function readInitialMode() {
  const stored = localStorage.getItem('themeMode');
  if (stored === 'light' || stored === 'auto' || stored === 'dark') return stored;
  // Migrate legacy boolean key
  const migrated = localStorage.getItem('darkMode') === 'true' ? 'dark' : 'light';
  localStorage.setItem('themeMode', migrated);
  localStorage.removeItem('darkMode');
  return migrated;
}

export function useTheme() {
  const [mode, setMode] = useState(readInitialMode);
  const [osDark, setOsDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  );

  // Track OS preference changes when in auto mode
  useEffect(() => {
    if (mode !== 'auto') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e) => setOsDark(e.matches);
    mq.addEventListener('change', handler);
    setOsDark(mq.matches);
    return () => mq.removeEventListener('change', handler);
  }, [mode]);

  const isDark = mode === 'dark' || (mode === 'auto' && osDark);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    localStorage.setItem('themeMode', mode);
  }, [isDark, mode]);

  const cycleTheme = () => setMode(m => MODES[(MODES.indexOf(m) + 1) % MODES.length]);

  return { isDark, mode, cycleTheme, setTheme: setMode };
}
