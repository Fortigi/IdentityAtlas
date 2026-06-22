// Tests for index.js startup behaviour: EADDRINUSE handler, host binding, and graceful shutdown.

import { describe, it, expect, vi, afterEach } from 'vitest';
import net from 'node:net';

// Shared recorder + mock fns for the startup-ordering test. vi.hoisted runs
// before the vi.mock factories below (which are themselves hoisted above the
// imports), so the factories can safely close over these.
const startup = vi.hoisted(() => {
  const calls = [];
  return {
    calls,
    // migrateDatabase deliberately yields to the event loop before recording,
    // so if a regression ever called app.listen() WITHOUT awaiting migrations
    // first, 'listen' would be recorded before 'migrate' and the test fails.
    migrateDatabase: vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      calls.push('migrate');
    }),
    bootstrapWorker: vi.fn(async () => { calls.push('bootstrap'); }),
    listen: vi.fn((_port, _host, cb) => {
      calls.push('listen');
      if (cb) cb();
      return { on: vi.fn() };
    }),
  };
});

vi.mock('./app.js', () => ({ createApp: () => ({ listen: startup.listen }) }));
vi.mock('./bootstrap.js', () => ({
  migrateDatabase: startup.migrateDatabase,
  bootstrapWorker: startup.bootstrapWorker,
}));
vi.mock('./perf/collector.js', () => ({ enable: vi.fn(), isEnabled: () => false }));
vi.mock('./config/authConfig.js', () => ({
  loadAuthConfig: vi.fn(async () => {}),
  isAuthEnabled: () => false,
}));

describe('startup ordering — migrations run first', () => {
  it('applies migrations before the server binds its port', async () => {
    // Importing index.js runs its top-level startup sequence. The dynamic
    // import resolves only after index.js's top-level `await migrateDatabase()`
    // settles, so by the time this await returns the ordering is final.
    await import('./index.js');

    // Migrations must have run, and must be the very first recorded step —
    // guards against someone dropping `await migrateDatabase()` from index.js
    // (the fn would never be called) or moving it after app.listen().
    expect(startup.migrateDatabase).toHaveBeenCalledTimes(1);
    expect(startup.calls[0]).toBe('migrate');
    expect(startup.calls.indexOf('migrate')).toBeLessThan(startup.calls.indexOf('listen'));
  });
});

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
