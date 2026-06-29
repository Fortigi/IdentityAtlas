import { createContext, useContext } from 'react';

// Context + hook for the in-app dialog system (see DialogProvider.jsx). Kept in
// a non-component module so DialogProvider.jsx only exports its component
// (Vite fast-refresh requirement).
export const DialogContext = createContext(null);

export function useDialog() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog must be used within <DialogProvider>');
  return ctx;
}
