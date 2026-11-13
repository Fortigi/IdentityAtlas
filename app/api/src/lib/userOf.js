// Who is calling: the signed-in user's e-mail, UPN, preferred username or
// name, or 'unknown' when the request carries no user (auth off, or an
// internal caller). One definition for every route that stamps a createdBy /
// setBy / triggeredBy column; it used to be re-typed per handler.

export const userOf = (req) =>
  (req.user && (req.user.email || req.user.upn || req.user.preferred_username || req.user.name)) || 'unknown';
