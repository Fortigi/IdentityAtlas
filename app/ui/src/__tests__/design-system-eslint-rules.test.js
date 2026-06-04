// Unit tests for the design-system ESLint rules (the "CI test" half of the
// UI Style Guide). Uses ESLint's Linter API so they run under vitest without
// the RuleTester test-framework coupling.
import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import noNativeDialogs from '../../eslint-rules/no-native-dialogs.js';
import noLegacyJargon from '../../eslint-rules/no-legacy-jargon.js';

const linter = new Linter();
function lint(code, name, rule) {
  return linter.verify(code, {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { local: { rules: { [name]: rule } } },
    rules: { [`local/${name}`]: 'error' },
  });
}

describe('no-native-dialogs', () => {
  it('flags confirm/alert/prompt (bare and window.*/globalThis.*)', () => {
    expect(lint("confirm('x')", 'no-native-dialogs', noNativeDialogs)).toHaveLength(1);
    expect(lint("window.alert('x')", 'no-native-dialogs', noNativeDialogs)).toHaveLength(1);
    expect(lint("globalThis.prompt('x')", 'no-native-dialogs', noNativeDialogs)).toHaveLength(1);
  });
  it('allows unrelated calls', () => {
    expect(lint("toast('x'); doConfirmThing();", 'no-native-dialogs', noNativeDialogs)).toHaveLength(0);
  });
});

describe('no-legacy-jargon', () => {
  it('flags banned terms in user-facing strings', () => {
    expect(lint("const s = 'Business Roles (SOLL)';", 'no-legacy-jargon', noLegacyJargon)).toHaveLength(1);
    expect(lint("const s = 'Run Start-FGSync now';", 'no-legacy-jargon', noLegacyJargon)).toHaveLength(1);
    expect(lint("const s = 'Contexts (Org Units)';", 'no-legacy-jargon', noLegacyJargon)).toHaveLength(1);
  });
  it('ignores clean strings', () => {
    expect(lint("const s = 'Governed via Business Roles';", 'no-legacy-jargon', noLegacyJargon)).toHaveLength(0);
  });
});
