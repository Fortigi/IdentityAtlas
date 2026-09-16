// @vitest-environment jsdom
//
// Every surface that renders an attribute NAME, mounted against one label map
// (issue #872). One file rather than five, because the point being pinned is
// exactly that these surfaces agree — including the xlsx export, which is
// asserted here against the same map so a divergence shows up as a failure in
// the same test file rather than as two green suites.
//
// Each case asserts the clean name is SHOWN *and* that the raw stored key is
// still what the control carries, because swapping the label in where the key
// was needed is how a working filter silently starts returning nothing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement as h } from 'react';
import { renderWithProviders, screen } from '@ui/test-utils/renderWithProviders';
import { setAttributeLabels, resetAttributeLabels } from '@ui/utils/attributeLabels';
import { AttributesTable } from './EntityDetailLayout';
import MatrixGroupingRow from './matrix/MatrixGroupingRow';
import AttributePicker from './matrix/AttributePicker';
import { writeAttributeHeaders } from '@ui/utils/exportToExcel.helpers';

const APP_A = '8ce8d3db3b314def88d829e15494e83f';
const SAM = `extension_${APP_A}_sAMAccountName`;
const TEAM = `extension_${APP_A}_sfTeamID`;
const OU = `extension_${APP_A}_fgGroupDN_OuPath`;

const LABELS = {
  [SAM]: 'sAMAccountName',
  [TEAM]: 'sfTeamID',
  [OU]: 'fgGroupDN_OuPath',
};

beforeEach(() => setAttributeLabels(LABELS));
afterEach(() => resetAttributeLabels());

describe('AttributesTable — entity detail page (AC1/AC12)', () => {
  const mount = (entries) => renderWithProviders(h(AttributesTable, { entries }));

  it('shows the clean name and keeps the original Entra key as its tooltip', () => {
    mount([[SAM, 'jdoe', { extended: true }]]);

    const label = screen.getByText('sAMAccountName');
    expect(label).toBeInTheDocument();
    expect(label).toHaveAttribute('title', SAM);
    // The reject criterion: the tenant guid must be nowhere in the visible text.
    expect(screen.queryByText(new RegExp(APP_A))).toBeNull();
  });

  it('keeps a derived _OuPath key readable (AC2)', () => {
    mount([[OU, 'Clients/Accounts/Users', { extended: true }]]);

    expect(screen.getByText('fgGroupDN_OuPath')).toBeInTheDocument();
  });

  it('does not word-split the name it was given (AC/D2)', () => {
    setAttributeLabels({ [`extension_${APP_A}_sfCostCenterID`]: 'sfCostCenterID' });
    mount([[`extension_${APP_A}_sfCostCenterID`, 'CC-9', { extended: true }]]);

    expect(screen.getByText('sfCostCenterID')).toBeInTheDocument();
    expect(screen.queryByText('Sf Cost Center I D')).toBeNull();
  });

  it('still humanises an ordinary key, with no tooltip added (AC3)', () => {
    mount([['jobTitle', 'Analyst']]);

    const label = screen.getByText('Job Title');
    expect(label).toBeInTheDocument();
    expect(label).not.toHaveAttribute('title');
  });

  it('falls back to the humanised key when no labels loaded (AC11)', () => {
    resetAttributeLabels();
    mount([['jobTitle', 'Analyst']]);

    expect(screen.getByText('Job Title')).toBeInTheDocument();
  });

  it('renders the empty state without asking for a label (AC5)', () => {
    mount([]);

    expect(screen.getByText('No attributes')).toBeInTheDocument();
  });
});

describe('MatrixGroupingRow — on-screen grouping header', () => {
  const mount = (attribute) => renderWithProviders(
    h('table', null, h('tbody', null, h(MatrixGroupingRow, {
      row: { attribute, spans: [] },
      rowIdx: 1,
      infoColumnCount: 3,
      users: [],
      accessPackages: [],
      isDark: false,
    }))),
  );

  it('names the group by the clean attribute name', () => {
    mount(`ext.${TEAM}`);

    expect(screen.getByText('sfTeamID')).toBeInTheDocument();
  });

  it('keeps humanising a real column', () => {
    mount('department');

    expect(screen.getByText('Department')).toBeInTheDocument();
  });

  it('falls back to the stripped key when the label map is empty', () => {
    resetAttributeLabels();
    mount(`ext.${TEAM}`);

    // Ugly, but present and non-crashing — the pre-#872 rendering.
    expect(screen.getByText(new RegExp(APP_A))).toBeInTheDocument();
  });
});

describe('AttributePicker — matrix "+ Attribute" field list (AC8)', () => {
  const columns = [
    { column: 'department', values: ['HR'] },
    { column: `ext.${TEAM}`, values: ['T-1', 'T-2'] },
    { column: 'ext.userType', values: ['Member'] },
  ];
  const mount = () => renderWithProviders(
    h(AttributePicker, { entity: 'Principal', columns, onPick: () => {}, onClose: () => {} }),
  );

  it('labels the option while its value stays the stored key', () => {
    mount();

    const option = screen.getByRole('option', { name: /^sfTeamID \(2\)$/ });
    expect(option).toHaveValue(`ext.${TEAM}`);
  });

  it('prefers a label the API already put on the column', () => {
    renderWithProviders(h(AttributePicker, {
      entity: 'Principal',
      columns: [{ column: `ext.${TEAM}`, label: 'Team (8ce8d3db)', values: ['T-1'] }],
      onPick: () => {}, onClose: () => {},
    }));

    expect(screen.getByRole('option', { name: /Team \(8ce8d3db\)/ })).toBeInTheDocument();
  });

  it('leaves an unlabelled ext key reading as its raw key (AC3)', () => {
    mount();

    expect(screen.getByRole('option', { name: /^ext\.userType \(1\)$/ })).toBeInTheDocument();
  });
});

describe('matrix xlsx export headers (AC7 — Excel matches the browser)', () => {
  // A minimal worksheet double: writeAttributeHeaders only needs getRow/getCell
  // and mergeCells, and what we assert is the string it puts in A1.
  function fakeSheet() {
    const cells = new Map();
    return {
      cells,
      getRow: () => ({ height: 0 }),
      getCell: (r, c) => {
        const key = `${r},${c}`;
        if (!cells.has(key)) cells.set(key, {});
        return cells.get(key);
      },
      mergeCells: () => {},
    };
  }

  const write = (attrs) => {
    const ws = fakeSheet();
    writeAttributeHeaders(ws, {
      attrs, headerLevels: attrs.length, infoColCount: 3,
      userCount: 0, users: [], apCount: 0, apColStart: 4,
    });
    return ws;
  };

  it('writes the same string the on-screen grouping header shows', () => {
    // The browser half, rendered from the same cache…
    renderWithProviders(h('table', null, h('tbody', null, h(MatrixGroupingRow, {
      row: { attribute: `ext.${TEAM}`, spans: [] },
      rowIdx: 0, infoColumnCount: 3, users: [], accessPackages: [], isDark: false,
    }))));
    const onScreen = screen.getByText('sfTeamID').textContent;

    // …and the workbook half.
    const ws = write([`ext.${TEAM}`]);

    expect(ws.getCell(1, 1).value).toBe(onScreen);
    expect(ws.getCell(1, 1).value).toBe('sfTeamID');
  });

  it('keeps humanising a real column in the workbook too', () => {
    expect(write(['department']).getCell(1, 1).value).toBe('Department');
  });

  it('falls back to the stripped key with no labels loaded', () => {
    resetAttributeLabels();
    expect(write([`ext.${TEAM}`]).getCell(1, 1).value).toContain(APP_A);
  });
});
