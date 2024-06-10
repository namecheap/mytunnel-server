import assert from 'assert';
import net from 'net';
import sinon from 'sinon';

import ClientManager from './ClientManager.js';

describe('ClientManager', () => {
  let clock;
  beforeEach(() => {
    clock = sinon.useFakeTimers({
    //   toFake: ['setTimeout'],
    });
  });
  afterEach(() => {
    clock.restore();
  });

  it('should construct with no tunnels', () => {
    const manager = new ClientManager();
    assert.equal(manager.stats.tunnels, 0);
  });

  it('should create a new client with random id', async () => {
    const manager = new ClientManager();
    const client = await manager.newClient();
    assert(manager.hasClient(client.id));
    manager.removeClient(client.id);
  });

  it('should create a new client with id', async () => {
    const manager = new ClientManager();
    const client = await manager.newClient('foobar');
    assert(manager.hasClient('foobar'));
    manager.removeClient('foobar');
  });

  it('should create a new client with random id if previous exists', async () => {
    const manager = new ClientManager();
    const clientA = await manager.newClient('foobar');
    const clientB = await manager.newClient('foobar');
    assert(clientA.id, 'foobar');
    assert(manager.hasClient(clientB.id));
    assert(clientB.id != clientA.id);
    manager.removeClient(clientB.id);
    manager.removeClient('foobar');
  });

  it('should remove client once it goes offline', async () => {
    const manager = new ClientManager();
    const client = await manager.newClient('foobar');

    const socket = await new Promise((resolve) => {
      const netClient = net.createConnection({ port: client.port }, () => {
        resolve(netClient);
      });
    });
    const closePromise = new Promise((resolve) => socket.once('close', resolve));
    socket.end();
    await closePromise;

    // should still have client - grace period has not expired
    assert(manager.hasClient('foobar'));

    // wait past grace period
    clock.tick(50_001);
    assert(!manager.hasClient('foobar'));
  });

  it('should remove correct client once it goes offline', async () => {
    const manager = new ClientManager();
    const clientFoo = await manager.newClient('foo');
    const clientBar = await manager.newClient('bar');

    const socket = await new Promise((resolve) => {
      const netClient = net.createConnection({ port: clientFoo.port }, () => {
        resolve(netClient);
      });
    });

    await clock.tickAsync(50_001);

    // foo should still be ok
    assert(manager.hasClient('foo'));
    // clientBar should be removed - nothing connected to it
    assert(!manager.hasClient('bar'));

    manager.removeClient('foo');
    socket.end();
  });

  it('should remove clients if they do not connect within grace timeout', async () => {
    const manager = new ClientManager();
    const clientFoo = await manager.newClient('foo');
    assert(manager.hasClient('foo'));

    // wait past grace period
    clock.tick(50_001);
    assert(!manager.hasClient('foo'));
  });
});
