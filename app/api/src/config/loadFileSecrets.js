// Side-effect import: resolves `<NAME>_FILE` secrets into the environment.
// Imported FIRST by the process entry points (index.js, cli/*) so the values are
// in place before any module reads them. See fileSecrets.js.
import { applyFileSecrets } from './fileSecrets.js';

const loaded = applyFileSecrets();
if (loaded.length) console.log(`Secrets loaded from files: ${loaded.join(', ')}`);
