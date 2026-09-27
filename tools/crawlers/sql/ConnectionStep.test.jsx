// @vitest-environment jsdom
// The connection step, mounted and driven: the render-only wizard tests never open
// the advanced panel, so its fields and their setter were never exercised.
import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';
import { ConnectionStep } from './ConfigWizard.jsx';

const ADVANCED = { connectTimeoutSeconds: '30', commandTimeoutSeconds: '600', batchSize: '5000', pageSize: '10000' };

// Holds the step's state the way the wizard does, and exposes it for assertions.
function Harness({ onState, port = '' }) {
  const [displayName, setDisplayName] = useState('SQL');
  const [server, setServer] = useState('db1');
  const [p, setPort] = useState(port);
  const [database, setDatabase] = useState('iiq');
  const [systemName, setSystemName] = useState('');
  const [connection, setConnection] = useState({ encrypt: true, trustServerCertificate: false });
  const [advanced, setAdvanced] = useState(ADVANCED);
  onState({ advanced, systemName });
  const fields = {
    displayName, setDisplayName, server, setServer, port: p, setPort, database, setDatabase,
    systemName, setSystemName, connection, setConnection, advanced, setAdvanced,
  };
  return <ConnectionStep fields={fields} onNext={() => {}} nextDisabled={false} />;
}

describe('SQL ConnectionStep', () => {
  it('opens the advanced panel, edits one run setting without touching the others, and closes again', async () => {
    let state;
    renderWithProviders(<Harness onState={s => { state = s; }} />);
    expect(screen.queryByText('Batch size')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    const batch = screen.getByDisplayValue('5000');
    await userEvent.clear(batch);
    await userEvent.type(batch, '250');
    expect(state.advanced).toEqual({ ...ADVANCED, batchSize: '250' });

    await userEvent.type(screen.getByPlaceholderText('IdentityIQ'), 'IIQ');
    expect(state.systemName).toBe('IIQ');

    await userEvent.click(screen.getByRole('button', { name: /Hide/ }));
    expect(screen.queryByText('Batch size')).toBeNull();
  });

  it('says why a port is rejected', () => {
    renderWithProviders(<Harness onState={() => {}} port="70000" />);
    expect(screen.getByText('Enter a port between 1 and 65535')).toBeTruthy();
  });
});
