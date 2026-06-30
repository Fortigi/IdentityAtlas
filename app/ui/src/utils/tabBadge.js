// Short badge shown at the start of an open detail tab, keyed by entity type.
// Kept out of App.jsx so the mapping can be unit-tested in isolation.
//
// #208: identity tabs previously fell through to the 'AP' (access-package)
// fallback and showed "AP" instead of "ID"; 'run' tabs hit the same fallback.
export function tabBadge(type) {
  switch (type) {
    case 'user':        return 'U';
    case 'resource':    return 'R';
    case 'group':       return 'G';
    case 'department':  return 'D';
    case 'context':     return 'C';
    case 'identity':    return 'ID';
    case 'run':         return 'RUN';
    case 'access-package':
    default:            return 'AP';
  }
}
