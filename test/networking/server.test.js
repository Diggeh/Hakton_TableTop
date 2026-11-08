import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  getLocalIpAddresses,
  getServerStatus,
  startServer,
  stopServer,
} from '../../backend/server.js';
import { SERVER_STATE } from '../../shared/events.js';

describe('Host Server Initialization & Lifecycle (backend/server.js)', () => {
  afterEach(async () => {
    await stopServer();
  });

  it('starts the host server on a configurable port and exposes status', async () => {
    const server = await startServer({ port: 0, host: '127.0.0.1' });

    assert.ok(server.port > 0, 'Expected bound port > 0');
    assert.equal(server.host, '127.0.0.1');
    assert.equal(typeof server.hostSecret, 'string');
    assert.ok(server.hostSecret.length >= 32);
    assert.equal(server.localUrl, `http://127.0.0.1:${server.port}`);

    const status = getServerStatus();
    assert.equal(status.running, true);
    assert.equal(status.state, SERVER_STATE.RUNNING);
    assert.equal(status.port, server.port);
    assert.ok(Array.isArray(status.lanIps));
  });

  it('prevents duplicate server instances from starting concurrently', async () => {
    await startServer({ port: 0, host: '127.0.0.1' });

    await assert.rejects(
      () => startServer({ port: 0, host: '127.0.0.1' }),
      (err) => {
        assert.equal(err.code, 'E_SERVER_ALREADY_RUNNING');
        return true;
      },
    );
  });

  it('rejects invalid port numbers gracefully', async () => {
    await assert.rejects(
      () => startServer({ port: -1, host: '127.0.0.1' }),
      (err) => {
        assert.equal(err.code, 'E_INVALID_PORT');
        return true;
      },
    );

    await assert.rejects(
      () => startServer({ port: 70000, host: '127.0.0.1' }),
      (err) => {
        assert.equal(err.code, 'E_INVALID_PORT');
        return true;
      },
    );

    const status = getServerStatus();
    assert.equal(status.running, false);
    assert.equal(status.state, SERVER_STATE.ERROR);
  });

  it('handles unavailable port (EADDRINUSE) gracefully and can start afterward', async () => {
    // Occupy an ephemeral port with a raw HTTP server
    const blocker = http.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const occupiedPort = blocker.address().port;

    try {
      await assert.rejects(
        () => startServer({ port: occupiedPort, host: '127.0.0.1' }),
        (err) => {
          assert.equal(err.code, 'EADDRINUSE');
          return true;
        },
      );

      const errorStatus = getServerStatus();
      assert.equal(errorStatus.running, false);
      assert.equal(errorStatus.state, SERVER_STATE.ERROR);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }

    // Should now be able to start cleanly on the freed port
    const server = await startServer({ port: occupiedPort, host: '127.0.0.1' });
    assert.equal(server.port, occupiedPort);
    assert.equal(getServerStatus().running, true);
  });

  it('stops cleanly, releases port, and restarts without duplicate listeners', async () => {
    const first = await startServer({ port: 0, host: '127.0.0.1' });
    const boundPort = first.port;

    await first.close();
    assert.equal(getServerStatus().running, false);
    assert.equal(getServerStatus().state, SERVER_STATE.STOPPED);

    const second = await startServer({ port: boundPort, host: '127.0.0.1' });
    assert.equal(second.port, boundPort);
    assert.equal(second.io.listenerCount('connection'), 1);

    await second.close();
  });

  it('enumerates local network IPv4 addresses as an array', () => {
    const ips = getLocalIpAddresses();
    assert.ok(Array.isArray(ips));
    for (const ip of ips) {
      assert.equal(typeof ip, 'string');
      assert.notEqual(ip, '127.0.0.1');
    }
  });
});
