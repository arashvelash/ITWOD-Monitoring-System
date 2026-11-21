import { UnauthorizedException } from '@nestjs/common';
import { createNodeAuthFixture, newNonce, nowSec, SERVER_ID, signHttp, signWsAuth } from '../helpers/fake-node';

describe('NodeAuthService', () => {
  it('accepts a correctly signed HTTP request', async () => {
    const { service } = createNodeAuthFixture();
    const node = await service.verifyHttp(signHttp('POST', '/api/v1/agent/reports', '{"reports":[]}'));
    expect(node).toMatchObject({ serverId: SERVER_ID, nodeId: 'ims-node-0001', type: 'UBUNTU' });
    expect(node.secret).toMatch(/^imss_/);
  });

  it('rejects a replayed nonce', async () => {
    const { service } = createNodeAuthFixture();
    const req = signHttp('GET', '/api/v1/agent/config', '');
    await service.verifyHttp(req);
    await expect(service.verifyHttp(req)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a tampered body or path', async () => {
    const { service } = createNodeAuthFixture();
    const req = signHttp('POST', '/api/v1/agent/reports', '{"reports":[]}');
    await expect(service.verifyHttp({ ...req, body: '{"reports":[1]}' })).rejects.toBeInstanceOf(UnauthorizedException);
    const req2 = signHttp('GET', '/api/v1/agent/config', '');
    await expect(service.verifyHttp({ ...req2, path: '/api/v1/agent/commands' })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects stale timestamps and malformed nonces', async () => {
    const { service } = createNodeAuthFixture();
    await expect(service.verifyHttp(signHttp('GET', '/x', '', { ts: nowSec() - 600 }))).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.verifyHttp(signHttp('GET', '/x', '', { nonce: 'short' }))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('requires the Ed25519 key signature when a public key is registered', async () => {
    const { service } = createNodeAuthFixture();
    await expect(service.verifyHttp(signHttp('GET', '/x', '', { withKey: false }))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('allows HMAC-only nodes without a registered key', async () => {
    const { service } = createNodeAuthFixture({ publicKey: null });
    await expect(service.verifyHttp(signHttp('GET', '/x', '', { withKey: false }))).resolves.toBeDefined();
  });

  it('rejects wrong secrets, revoked credentials and revoked servers', async () => {
    await expect(createNodeAuthFixture().service.verifyHttp(signHttp('GET', '/x', '', { secret: 'imss_other' }))).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(createNodeAuthFixture({ revoked: true }).service.verifyHttp(signHttp('GET', '/x', ''))).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(createNodeAuthFixture({ status: 'REVOKED' }).service.verifyHttp(signHttp('GET', '/x', ''))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('verifies WebSocket auth frames', async () => {
    const { service } = createNodeAuthFixture();
    await expect(service.verifyWsAuth(signWsAuth())).resolves.toMatchObject({ serverId: SERVER_ID });
    const frame = signWsAuth({ nonce: newNonce() });
    await expect(service.verifyWsAuth({ ...frame, ts: String(frame.ts) })).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
