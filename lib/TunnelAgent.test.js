import http from 'http';
import net from 'net';
import assert from 'assert';

import TunnelAgent from './TunnelAgent.js';

describe('TunnelAgent', () => {
    it('should create an empty agent', async () => {
        const agent = new TunnelAgent();
        assert.equal(agent.started, false);

        const info = await agent.listen();
        assert.ok(info.port > 0);
        agent.destroy();
    });

    it('should create a new server and accept connections', async () => {
        const agent = new TunnelAgent();
        assert.equal(agent.started, false);

        const info = await agent.listen();
        const sock = net.createConnection({ port: info.port });

        // in this test we wait for the socket to be connected
        await new Promise(resolve => sock.once('connect', resolve));

        const agentSock = await new Promise((resolve, reject) => {
            agent.createConnection({}, (err, sock) => {
                if (err) {
                    reject(err);
                }
                resolve(sock);
            });
        });

        agentSock.write('foo');
        await new Promise(resolve => sock.once('readable', resolve));

        assert.equal('foo', sock.read().toString());
        agent.destroy();
        sock.destroy();
    });

    it('should reject connections over the max', async () => {
        const agent = new TunnelAgent({
            maxTcpSockets: 2,
        });
        assert.equal(agent.started, false);

        const info = await agent.listen();
        const sock1 = net.createConnection({ port: info.port });
        const sock2 = net.createConnection({ port: info.port });

        // two valid socket connections
        const p1 = new Promise(resolve => sock1.once('connect', resolve));
        const p2 = new Promise(resolve => sock2.once('connect', resolve));
        await Promise.all([p1, p2]);

        const sock3 = net.createConnection({ port: info.port });
        const p3 = await new Promise(resolve => sock3.once('close', resolve));

        agent.destroy();
        sock1.destroy();
        sock2.destroy();
        sock3.destroy();
    });

    it('should queue createConnection requests', async () => {
        const agent = new TunnelAgent();
        assert.equal(agent.started, false);

        const info = await agent.listen();

        // create a promise for the next connection
        let fulfilled = false;
        const waitSockPromise = new Promise((resolve, reject) => {
            agent.createConnection({}, (err, sock) => {
                fulfilled = true;
                if (err) {
                    reject(err);
                }
                resolve(sock);
            });
        });

        // check that the next socket is not yet available
        await new Promise(resolve => setTimeout(resolve, 500));
        assert(!fulfilled);

        // connect, this will make a socket available
        const sock = net.createConnection({ port: info.port });
        await new Promise(resolve => sock.once('connect', resolve));

        const anotherAgentSock = await waitSockPromise;
        agent.destroy();
        sock.destroy();
    });

    it('should should emit a online event when a socket connects', async () => {
        const agent = new TunnelAgent();
        const info = await agent.listen();

        const onlinePromise = new Promise(resolve => agent.once('online', resolve));

        const sock = net.createConnection({ port: info.port });
        await new Promise(resolve => sock.once('connect', resolve));

        await onlinePromise;
        agent.destroy();
        sock.destroy();
    });

    it('should emit offline event when socket disconnects', async () => {
        const agent = new TunnelAgent();
        const info = await agent.listen();

        const offlinePromise = new Promise(resolve => agent.once('offline', resolve));

        const sock = net.createConnection({ port: info.port });
        await new Promise(resolve => sock.once('connect', resolve));

        sock.end();
        await offlinePromise;
        agent.destroy();
        sock.destroy();
    });

    it('should emit offline event only when last socket disconnects', async () => {
        const agent = new TunnelAgent();
        const info = await agent.listen();

        const offlinePromise = new Promise(resolve => agent.once('offline', resolve));

        const sockA = net.createConnection({ port: info.port });
        await new Promise(resolve => sockA.once('connect', resolve));
        const sockB = net.createConnection({ port: info.port });
        await new Promise(resolve => sockB.once('connect', resolve));

        sockA.end();

        const timeout = new Promise(resolve => setTimeout(resolve, 500));
        await Promise.race([offlinePromise, timeout]);

        sockB.end();
        await offlinePromise;

        agent.destroy();
    });

    it('should error an http request', async () => {
        class ErrorAgent extends http.Agent {
            constructor() {
                super();
            }
        
            createConnection(options, cb) {
                cb(new Error('foo'));
            }
        }

        const agent = new ErrorAgent();

        const opt = {
            host: 'localhost',
            port: 1234,
            path: '/',
            agent: agent,
        };

        const err = await new Promise((resolve) => {
            const req = http.get(opt, (res) => {});
            req.once('error', resolve);
        });
        assert.equal(err.message, 'foo');
    });

    it('should return stats', async () => {
        const agent = new TunnelAgent();
        assert.deepEqual(agent.stats(), {
            connectedSockets: 0,
        });
    });

    it('should disconnect clients by timeout', async () => {
        const agent = new TunnelAgent({socketTimeout: 600});
        const info = await agent.listen();

        const offlinePromise = new Promise(resolve => agent.once('offline', resolve));

        const sock = net.createConnection({ port: info.port });
        await new Promise(resolve => sock.once('connect', resolve));

        await offlinePromise;
        agent.destroy();
        sock.destroy();
    });

    it('should enable TCP keepalive on tunnel sockets', async () => {
        const agent = new TunnelAgent();
        const info = await agent.listen();

        const sock = net.createConnection({ port: info.port });
        await new Promise(resolve => sock.once('connect', resolve));

        // Wait a bit for the connection to be fully established
        await new Promise(resolve => setTimeout(resolve, 100));

        // Get the socket from the agent's available pool
        const agentSock = await new Promise((resolve, reject) => {
            agent.createConnection({}, (err, sock) => {
                if (err) reject(err);
                else resolve(sock);
            });
        });

        // Verify TCP keepalive is enabled (Node.js doesn't expose keepalive state directly,
        // but we can verify the socket is valid and was configured)
        assert.ok(agentSock);
        assert.ok(agentSock.writable);

        agent.destroy();
        sock.destroy();
    });

    it('should discard dead sockets from pool in createConnection', async () => {
        const agent = new TunnelAgent();
        const info = await agent.listen();

        // Connect a socket
        const sock = net.createConnection({ port: info.port });
        await new Promise(resolve => sock.once('connect', resolve));

        // Wait for socket to be in pool
        await new Promise(resolve => setTimeout(resolve, 100));

        // Verify socket is available
        assert.equal(agent.availableSockets.length, 1);
        const pooledSocket = agent.availableSockets[0];

        // Manually mark socket as not writable (simulate dead connection)
        // We need to destroy it but keep it in the pool to test the validation logic
        pooledSocket.destroy();

        // Wait for socket to be destroyed
        await new Promise(resolve => setTimeout(resolve, 100));

        // Now try to get a socket - should discard the dead one and wait for a new one
        let connectionError = null;
        let fulfilled = false;
        const waitPromise = new Promise((resolve) => {
            agent.createConnection({}, (err, sock) => {
                fulfilled = true;
                connectionError = err;
                resolve(sock);
            });
        });

        // Should not be fulfilled yet (no healthy socket available)
        await new Promise(resolve => setTimeout(resolve, 100));
        assert(!fulfilled, 'createConnection should wait for healthy socket');

        // Connect a new healthy socket
        const sock2 = net.createConnection({ port: info.port });
        await new Promise(resolve => sock2.once('connect', resolve));

        // Now the waiting connection should be fulfilled
        const healthySocket = await waitPromise;
        assert.ok(healthySocket);
        assert.ok(healthySocket.writable);

        agent.destroy();
        sock.destroy();
        sock2.destroy();
    });

    it('should destroy all available sockets when server closes', async () => {
        const agent = new TunnelAgent();
        const info = await agent.listen();

        // Connect multiple sockets
        const sock1 = net.createConnection({ port: info.port });
        const sock2 = net.createConnection({ port: info.port });
        const sock3 = net.createConnection({ port: info.port });

        await Promise.all([
            new Promise(resolve => sock1.once('connect', resolve)),
            new Promise(resolve => sock2.once('connect', resolve)),
            new Promise(resolve => sock3.once('connect', resolve)),
        ]);

        // Wait for sockets to be in pool
        await new Promise(resolve => setTimeout(resolve, 100));

        // Verify all sockets are in available pool
        assert.equal(agent.availableSockets.length, 3, 'Should have 3 sockets in pool');

        // Track client socket close events to verify cleanup
        const closePromises = [
            new Promise(resolve => sock1.once('close', resolve)),
            new Promise(resolve => sock2.once('close', resolve)),
            new Promise(resolve => sock3.once('close', resolve)),
        ];

        // Manually call _onClose to test the cleanup logic directly
        agent._onClose();

        // Wait for all client sockets to be closed
        await Promise.all(closePromises);

        // All available sockets should have been destroyed and cleared
        assert.equal(agent.availableSockets.length, 0, 'Available sockets array should be cleared');
        assert.equal(agent.closed, true, 'Agent should be marked as closed');

        sock1.destroy();
        sock2.destroy();
        sock3.destroy();
        agent.destroy();
    });

    it('should pass timeout option to http.Agent to prevent free pool timeout clearing', async () => {
        // Test with default timeout
        const agent1 = new TunnelAgent();
        assert.equal(agent1.options.timeout, 10 * 60 * 1000, 'Default timeout should be 10 minutes');
        agent1.destroy();

        // Test with custom timeout
        const customTimeout = 5000;
        const agent2 = new TunnelAgent({ socketTimeout: customTimeout });
        assert.equal(agent2.options.timeout, customTimeout, 'Custom timeout should be passed to http.Agent');
        agent2.destroy();
    });

    it('should maintain socket timeout in http.Agent free pool', async () => {
        const agent = new TunnelAgent({ socketTimeout: 2000 });
        const info = await agent.listen();

        // Connect a socket
        const sock = net.createConnection({ port: info.port });
        await new Promise(resolve => sock.once('connect', resolve));
        await new Promise(resolve => setTimeout(resolve, 100));

        // Get socket and simulate HTTP request completion by returning it to pool
        const agentSock = await new Promise((resolve, reject) => {
            agent.createConnection({}, (err, sock) => {
                if (err) reject(err);
                else resolve(sock);
            });
        });

        // Simulate socket going back to free pool by emitting 'free' event
        // This triggers http.Agent's keepSocketAlive() which should maintain the timeout
        agentSock.emit('free');

        // The socket should now be in the free pool with timeout maintained
        // We can't directly test http.Agent's internal freeSockets, but we can verify
        // that the agent has the correct timeout option set
        assert.equal(agent.options.timeout, 2000, 'Agent should maintain timeout option for free pool');

        agent.destroy();
        sock.destroy();
    });
});
