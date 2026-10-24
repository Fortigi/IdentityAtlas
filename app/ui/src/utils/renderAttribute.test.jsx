import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderAttributeValue, isEntraPortalUrl } from './renderAttribute.jsx';

const html = (key, val) => renderToStaticMarkup(<>{renderAttributeValue(key, val)}</>);

describe('isEntraPortalUrl', () => {
  it('accepts https links on the Entra and Azure portal hosts', () => {
    expect(isEntraPortalUrl('https://entra.microsoft.com/#view/Microsoft_AAD_IAM/GroupDetailsMenuBlade/~/Overview/groupId/1')).toBe(true);
    expect(isEntraPortalUrl('https://PORTAL.AZURE.COM/#blade/x')).toBe(true);
    expect(isEntraPortalUrl('https://portal.azure.us/#blade/x')).toBe(true);
  });

  it('rejects look-alike hosts, other schemes, credentials and non-strings', () => {
    expect(isEntraPortalUrl('https://entra.microsoft.com.attacker.example/')).toBe(false);
    expect(isEntraPortalUrl('https://attacker.example/entra.microsoft.com')).toBe(false);
    expect(isEntraPortalUrl('https://login-entra.microsoft.com/')).toBe(false);
    expect(isEntraPortalUrl('http://entra.microsoft.com/')).toBe(false);
    expect(isEntraPortalUrl('https://entra.microsoft.com@attacker.example/')).toBe(false);
    expect(isEntraPortalUrl('https://user:pw@entra.microsoft.com/')).toBe(false);
    expect(isEntraPortalUrl('not a url')).toBe(false);
    expect(isEntraPortalUrl(42)).toBe(false);
  });
});

describe('renderAttributeValue', () => {
  it('labels an Entra portal Link as "Open in Entra ID"', () => {
    const out = html('Link', 'https://entra.microsoft.com/#view/x');
    expect(out).toContain('Open in Entra ID');
    expect(out).toContain('href="https://entra.microsoft.com/#view/x"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('shows a Link on any other host as its real URL, never with the Entra label (SEC-2026-09 L-18)', () => {
    const out = html('Link', 'https://entra-login.attacker.example/signin');
    expect(out).not.toContain('Open in Entra ID');
    expect(out).toContain('>https://entra-login.attacker.example/signin</a>');
  });

  it('renders any other URL attribute as a plain link showing the URL', () => {
    const out = html('Homepage', 'https://intranet.example/wiki');
    expect(out).toContain('>https://intranet.example/wiki</a>');
    expect(out).not.toContain('Open in Entra ID');
  });

  it('does not linkify a non-http value, even under the Link key', () => {
    const out = html('Link', 'javascript:alert(1)');
    expect(out).not.toContain('<a');
  });
});
