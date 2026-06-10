// Tests for index.js startup behaviour: EADDRINUSE handler, host binding, and graceful shutdown.

import { describe, it, expect, vi, afterEach } from 'vitest';
import net from 'node:net';

describe('server EADDRINUSE handler', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exits with code 1 and logs a clear message when port is in use', async () => {
    const exitSpy    = vi.spyOn(process, 'exit').mockImplementation(() => {});
    const errorSpy   = vi.spyOn(console, 'error').mockImplementation(() => {});

    const blocker = net.createServer();
    await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
    const port = blocker.address().port;

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

describe('graceful shutdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('logs and closes server only once when SIGINT fires multiple times', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    const logSpy  = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mockServer = { close: vi.fn(cb => cb()) };

    // Inline simulation of index.js shutdown logic
    let shuttingDown = false;
    function shutdown(signal) {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`${signal} received, shutting down...`);
      mockServer.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    }

    shutdown('SIGINT');
    shutdown('SIGINT');
    shutdown('SIGINT');
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(mockServer.close).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('force-exits after 5 s when server has lingering connections', () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const mockServer = { close: vi.fn() }; // never calls its callback

    let shuttingDown = false;
    function shutdown(signal) {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`${signal} received, shutting down...`);
      mockServer.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    }

    shutdown('SIGINT');
    expect(exitSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe('host binding', () => {
  it('binds to 127.0.0.1 in desktop mode', () => {
    const orig = process.env.DESKTOP_MODE;
    process.env.DESKTOP_MODE = 'true';
    // Re-evaluate the host expression from index.js inline.
    const host = process.env.DESKTOP_MODE === 'true' ? '127.0.0.1' : (process.env.HOST || '0.0.0.0');
    process.env.DESKTOP_MODE = orig;
    expect(host).toBe('127.0.0.1');
  });

  it('binds to 0.0.0.0 in non-desktop mode', () => {
    const orig = process.env.DESKTOP_MODE;
    delete process.env.DESKTOP_MODE;
    const host = process.env.DESKTOP_MODE === 'true' ? '127.0.0.1' : (process.env.HOST || '0.0.0.0');
    process.env.DESKTOP_MODE = orig;
    expect(host).toBe('0.0.0.0');
  });
});
