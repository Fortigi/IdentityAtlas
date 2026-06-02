export function buildAttributeEntries(attributes, extendedAttributes, hiddenKeys) {
  const hide = hiddenKeys instanceof Set ? hiddenKeys : new Set(hiddenKeys || []);
  const core = Object.entries(attributes || {})
    .filter(([k, v]) => !hide.has(k) && v != null && v !== '');
  // Put id first if present
  core.sort((a, b) => (a[0] === 'id' ? -1 : b[0] === 'id' ? 1 : 0));

  const extended = Object.entries(extendedAttributes || {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => [k, v, { extended: true }]);

  return [...core, ...extended];
}
