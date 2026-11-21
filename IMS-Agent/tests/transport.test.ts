import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicKey, verify } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { CoreClient } from '../src/core-client';
import { WsClient } from '../src/ws-client';
import { canonicalHttp, canonicalWsAuth, hmacHex, sha256Hex } from '../src/protocol';
import { vectorKey, vectors } from './helpers';

/**
 * A miniature Core that verifies signatures exactly like IMS-Core does,
 * proving the agent transport is interoperable end to end.
 */
describe('agent transport against a verifying mock Core', () => {
  let server: Server;
  let base: string;
  const key = vectorKey();
  const pub = createPublicKey(key);
  const seen: { path: string; ok: boolean }[] = [];

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const h = req.headers;
        const canonical = canonicalHttp(req.method!, req.url!, Number(h['x-ims-timestamp']), String(h['x-ims-nonce']), body);
        const ok =
          h['x-ims-node-id'] === 'ims-node-0001' &&
          hmacHex(vectors.nodeSecret, canonical) === h['x-ims-signature'] &&
          verify(null, Buffer.from(canonical), pub, Buffer.from(String(h['x-ims-key-signature']), 'base64'));
        seen.push({ path: req.url!, ok });
        res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
        res.end(JSON.stringify(ok ? { echoSha: sha256Hex(body) } : { message: 'bad signature' }));
      });
    });
    const wss = new WebSocketServer({ server, path: '/ws/agent' });
    wss.on('connection', (ws) => {
      ws.once('message', (raw) => {
        const m = JSON.parse(raw.toString());
        const canonical = canonicalWsAuth(m.nodeId, m.ts, m.nonce);
        const ok = hmacHex(vectors.nodeSecret, canonical) === m.signature && verify(null, Buffer.from(canonical), pub, Buffer.from(m.keySignature, 'base64'));
        if (!ok) return ws.close(4401);
        ws.send(JSON.stringify({ type: 'auth.ok', serverTime: 0, heartbeatIntervalSec: 30, metricsIntervalSec: 60, configVersion: 5 }));
        ws.send(JSON.stringify({ type: 'heartbeat.ack', configVersion: 5 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise((r) => server.close(r)));

  it('signs HTTPS requests that Core accepts (GET and POST)', async () => {
    const client = new CoreClient({ coreUrl: `http://${base}`, nodeId: 'ims-node-0001', nodeSecret: vectors.nodeSecret, privateKey: key });
    await expect(client.request('GET', '/api/v1/agent/config?x=1')).resolves.toBeDefined();
    const body = { reports: [{ type: 'heartbeat', data: { uptimeSec: 1 } }] };
    const res = await client.request<{ echoSha: string }>('POST', '/api/v1/agent/reports', body);
    expect(res.echoSha).toBe(sha256Hex(JSON.stringify(body)));
    expect(seen.every((s) => s.ok)).toBe(true);
  });

  it('rejects when signed with the wrong secret', async () => {
    const client = new CoreClient({ coreUrl: `http://${base}`, nodeId: 'ims-node-0001', nodeSecret: 'imss_wrong', privateKey: key });
    await expect(client.request('GET', '/api/v1/agent/config')).rejects.toThrow(/401/);
  });

  it('authenticates the WebSocket and receives frames', async () => {
    const ws = new WsClient({ url: `ws://${base}/ws/agent`, nodeId: 'ims-node-0001', nodeSecret: vectors.nodeSecret, privateKey: key });
    const authed = new Promise<any>((r) => ws.once('authenticated', r));
    const frame = new Promise<any>((r) => ws.once('message', r));
    ws.start();
    expect(await authed).toMatchObject({ configVersion: 5 });
    expect(await frame).toMatchObject({ type: 'heartbeat.ack' });
    expect(ws.connected).toBe(true);
    ws.stop();
  });
});
