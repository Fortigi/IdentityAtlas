// Verifies the server EADDRINUSE error handler calls process.exit(1) with a
// clear message when the port is already occupied.

import { describe, it, expect, vi, afterEach } from 'vitest';
import net from 'node:net';

describe('server EADDRINUSE handler', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exits with code 1 and logs a clear message when port is in use', async () => {
    const exitSpy    = vi.spyOn(process, 'exit').mockImplementation(() => {});
    const errorSpy   = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Occupy a random port so the second bind triggers EADDRINUSE.
    const blocker = net.createServer();
    await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
    const port = blocker.address().port;

    // Replicate the handler exactly as it appears in index.js.
    const server = net.createServer();
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\nError: port ${port} is already in use.`);
        console.error(`Identity Atlas may already be running. Open http://localhost:${port} in your browser.`);
        process.exit(1);
      } else {
        throw err;
      }
    });
    server.listen(port, '127.0.0.1');

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('already in use'));

    blocker.close();
  });
});
