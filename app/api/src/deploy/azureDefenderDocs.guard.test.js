// Regression guard for #1163 (document + exempt): Microsoft Defender for
// Cloud's "App Service apps should have authentication enabled" recommendation
// reads the App Service platform auth config (authSettingsV2 / Easy Auth),
// which the Azure deployment intentionally never configures — Identity Atlas
// enforces Entra sign-in inside the app (app/api/src/middleware/auth.js).
//
// The finding is therefore expected on every deployment, and the walkthrough is
// the only place that can tell a deployer so. This pins that documentation:
// the walkthrough must name the recommendation, explain it as by design, and
// describe the Defender exemption that clears the marker.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const walkthrough = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../docs/architecture/azure-deployment-walkthrough.md'
  ),
  'utf8'
);

describe('Azure walkthrough — Defender for Cloud auth recommendation (#1163)', () => {
  it('names the Defender for Cloud recommendation that flags the web app', () => {
    expect(walkthrough).toMatch(/defender for cloud/i);
    expect(walkthrough).toMatch(/authentication enabled/i);
  });

  it('describes the exemption path that clears the finding', () => {
    expect(walkthrough).toMatch(/exempt/i);
  });
});
