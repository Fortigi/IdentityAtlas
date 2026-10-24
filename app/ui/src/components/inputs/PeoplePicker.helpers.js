// Pure helpers for PeoplePicker.jsx, kept out of the component file so React Fast
// Refresh can hot-swap it (react-refresh/only-export-components).

// The picker's value shape, from a /api/users row. `userKey` is the sign-in
// name; `principalId` keeps the directory id so a later rename still resolves.
export function toPerson(row) {
  return {
    principalId: row.id || null,
    userKey: row.userPrincipalName || row.email || '',
    displayName: row.displayName || row.userPrincipalName || row.email || '',
  };
}
