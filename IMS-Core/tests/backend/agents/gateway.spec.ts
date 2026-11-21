import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { AgentGatewayService } from '../../../backend/src/agents/agent-gateway.service';
import { ConnectionRegistry } from '../../../backend/src/agents/connection-registry';
import { canonicalCommand, verifyHmacHex } from '../../../backend/src/crypto/node-protocol';
import { createNodeAuthFixture, SERVER_ID, signWsAuth } from '../helpers/fake-node';
import { vectors } from '../helpers/vectors';

/** End-to-end test of the agent WebSocket handshake over a real socket. */
describe('AgentGatewayService (WebSocket)', () => {
  let http: Server;
  let url: string;
  let gateway: AgentGatewayService;
  const registry = new ConnectionRegistry();
  const events = { dispatch: jest.fn().mockResolvedValue(undefined), heartbeat: jest.fn().mockResolvedValue(undefined) };
  const commands = { deliverPending: jest.fn().mockResolvedValue(0) };
  const agentConfig = { currentVersion: jest.fn().mockResolvedValue(3) };
  const prisma = { server: { update: jest.fn().mockResolvedValue({}) } };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };

  beforeAll(async () => {
    const { service } = createNodeAuthFixture();
    gateway = new AgentGatewayService(service, registry, events as never, commands as never, agentConfig as never, prisma as never, audit as never);
    http = createServer();
    gateway.attach(http);
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/ws/agent`;
  });

  afterAll(async () => {
    gateway.onApplicationShutdown();
    await new Promise((r) => http.close(r));
  });

  function connect(): Promise<{ ws: WebSocket; next: () => Promise<any>; closed: Promise<number> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const queue: any[] = [];
      const waiters: ((m: any) => void)[] = [];
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        const w = waiters.shift();
        if (w) w(m);
        else queue.push(m);
      });
      const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
      ws.on('open', () => resolve({ ws, closed, next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))) }));
      ws.on('error', reject);
    });
  }

  it('authenticates, acknowledges heartbeats and dispatches frames', async () => {
    const { ws, next } = await connect();
    ws.send(JSON.stringify(signWsAuth()));
    const ok = await next();
    expect(ok).toMatchObject({ type: 'auth.ok', configVersion: 3, heartbeatIntervalSec: 30 });
    expect(registry.isConnected(SERVER_ID)).toBe(true);
    expect(commands.deliverPending).toHaveBeenCalledWith(SERVER_ID);

    ws.send(JSON.stringify({ type: 'heartbeat', uptimeSec: 5 }));
    expect(await next()).toMatchObject({ type: 'heartbeat.ack', configVersion: 3 });
    expect(events.dispatch).toHaveBeenCalledWith(expect.objectContaining({ serverId: SERVER_ID }), 'heartbeat', { uptimeSec: 5 });

    ws.send(JSON.stringify({ type: 'metrics', data: { collectedAt: 'x' } }));
    await new Promise((r) => setTimeout(r, 50));
    expect(events.dispatch).toHaveBeenCalledWith(expect.anything(), 'metrics', { collectedAt: 'x' });
    ws.close();
  });

  it('delivers signed commands through the registry', async () => {
    const { ws, next } = await connect();
    ws.send(JSON.stringify(signWsAuth()));
    await next();
    const payload = '{"a":1}';
    const now = Math.floor(Date.now() / 1000);
    const { signCommand } = await import('../../../backend/src/crypto/node-protocol');
    registry.send(SERVER_ID, signCommand(vectors.nodeSecret, { id: 'c1', command: 'ping', issuedAt: now, expiresAt: now + 60, payload }));
    const cmd = await next();
    expect(cmd.type).toBe('command');
    expect(verifyHmacHex(vectors.nodeSecret, canonicalCommand(cmd.id, cmd.command, cmd.issuedAt, cmd.expiresAt, cmd.payload), cmd.signature)).toBe(true);
    ws.close();
  });

  it('closes with 4401 on a bad signature', async () => {
    const { ws, closed } = await connect();
    ws.send(JSON.stringify({ ...signWsAuth(), signature: '0'.repeat(64) }));
    expect(await closed).toBe(4401);
  });

  it('closes with 4401 when the first frame is not auth', async () => {
    const { ws, closed } = await connect();
    ws.send(JSON.stringify({ type: 'heartbeat' }));
    expect(await closed).toBe(4401);
  });

  it('replaces an older connection of the same node with 4409', async () => {
    const a = await connect();
    a.ws.send(JSON.stringify(signWsAuth()));
    await a.next();
    const b = await connect();
    b.ws.send(JSON.stringify(signWsAuth()));
    await b.next();
    expect(await a.closed).toBe(4409);
    b.ws.close();
  });
});
