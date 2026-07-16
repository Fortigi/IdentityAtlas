// @vitest-environment jsdom
//
// Guards #755 (audit M3): the Admin section headers use the shared inline-SVG
// icon set instead of emoji-as-icon. Covers the icon components, the adminUi
// Section icon slot rendering an SVG, and the Danger Zone header migration.

import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '@ui/test-utils/renderWithProviders';
import {
  CuratedDataIcon,
  WorkbookIcon,
  RiskProfileIcon,
  ClassifiersIcon,
  WarningIcon,
} from './adminIcons';
import { Section } from './adminUi';
import DangerZoneSection from './DangerZoneSection';

const ICONS = { CuratedDataIcon, WorkbookIcon, RiskProfileIcon, ClassifiersIcon, WarningIcon };

describe('admin section icons (#755)', () => {
  for (const [name, IconCmp] of Object.entries(ICONS)) {
    it(`${name} renders an inheritable inline SVG (currentColor), no emoji`, () => {
      const { container } = renderWithProviders(<IconCmp />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
      expect(svg.getAttribute('stroke')).toBe('currentColor');
      expect(svg.querySelector('path')).toBeTruthy();
      // aria-hidden by default (decorative) so screen readers skip it.
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    });
  }

  it('accepts a className override for sizing', () => {
    const { container } = renderWithProviders(<WarningIcon className="w-4 h-4 text-red-600" />);
    expect(container.querySelector('svg').getAttribute('class')).toContain('w-4');
  });

  it('adminUi Section renders an SVG icon in its header instead of an emoji glyph', () => {
    const { container } = renderWithProviders(
      <Section title="Curated Data" icon={<CuratedDataIcon />} defaultOpen>
        <div>body</div>
      </Section>,
    );
    expect(screen.getByText('Curated Data')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeTruthy();
    expect(container.textContent).not.toMatch(/📦|📊|🏢|🎯/);
  });

  it('DangerZoneSection header shows the warning icon, not the ⚠️ emoji', () => {
    const { container } = renderWithProviders(<DangerZoneSection onRefresh={() => {}} />);
    expect(screen.getByText('Danger Zone')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeTruthy();
    expect(container.textContent).not.toContain('⚠️');
  });
});
