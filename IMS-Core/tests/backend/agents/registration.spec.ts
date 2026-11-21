import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AgentRegistrationService } from '../../../backend/src/agents/agent-registration.service';
import { SecretBoxService } from '../../../backend/src/crypto/secret-box.service';
import { sha256Hex } from '../../../backend/src/crypto/tokens';
import { testConfig } from '../helpers/test-config';
import { vectors } from '../helpers/vectors';

const TOKEN = 'imsr_' + 'A'.repeat(32);
const ctx = { ip: '198.51.100.7', userAgent: null };

function fixture(opts: { type?: 'UBUNTU' | 'CPANEL'; expired?: boolean; used?: boolean } = {}) {
  const box = new SecretBoxService(testConfig());
  const server = { id: 'srv-1', nodeId: 'ims-node-0007', type: opts.type ?? 'UBUNTU', status: 'PENDING' };
  const token = {
    id: 'tok-1',
    serverId: server.id,
    tokenHash: sha256Hex(TOKEN),
    usedAt: opts.used ? new Date() : (null as Date | null),
    revokedAt: null as Date | null,
    expiresAt: new Date(Date.now() + (opts.expired ? -1000 : 3_600_000)),
    server,
  };
  const state: { credential?: any; serverUpdate?: any } = {};
  const tx = {
    registrationToken: {
      updateMany: async ({ where, data }: any) => {
        if (where.id === token.id) {
          if (token.usedAt || token.revokedAt || token.expiresAt <= new Date()) return { count: 0 };
          Object.assign(token, data);
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
    nodeCredential: { upsert: async ({ create }: any) => (state.credential = create) },
    server: { update: async ({ data }: any) => (state.serverUpdate = data) },
  };
  const prisma = {
    registrationToken: { findUnique: async ({ where }: any) => (where.tokenHash === token.tokenHash ? token : null) },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new AgentRegistrationService(prisma as never, box, audit as never), state, box, token };
}

const input = (over: Record<string, unknown> = {}) =>
  ({ registrationToken: TOKEN, publicKey: vectors.ed25519.publicKeyBase64, agentType: 'UBUNTU', agentVersion: '1.0.0', hostname: 'web-01', os: 'Ubuntu 24.04', arch: 'x64', ...over }) as never;

describe('AgentRegistrationService', () => {
  it('registers once and stores only the encrypted secret', async () => {
    const f = fixture();
    const res = await f.service.register(input(), ctx);
    expect(res.nodeId).toBe('ims-node-0007');
    expect(res.nodeSecret).toMatch(/^imss_[A-Za-z0-9_-]{43}$/);
    expect(res.keyFingerprint).toBe(vectors.ed25519.fingerprint);
    expect(f.state.credential.secretEncrypted).not.toContain(res.nodeSecret);
    expect(f.box.decrypt(f.state.credential.secretEncrypted, 'node-secret:srv-1')).toBe(res.nodeSecret);
    expect(f.state.serverUpdate.status).toBe('OFFLINE');
    // Second use of the same token fails.
    await expect(f.service.register(input(), ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects expired and used tokens', async () => {
    await expect(fixture({ expired: true }).service.register(input(), ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(fixture({ used: true }).service.register(input(), ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(fixture().service.register(input({ registrationToken: 'imsr_' + 'B'.repeat(32) }), ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('enforces agent type and key requirements', async () => {
    await expect(fixture({ type: 'CPANEL' }).service.register(input(), ctx)).rejects.toBeInstanceOf(BadRequestException);
    await expect(fixture().service.register(input({ publicKey: undefined }), ctx)).rejects.toBeInstanceOf(BadRequestException);
    await expect(fixture().service.register(input({ publicKey: 'Zm9v' }), ctx)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows HMAC-only cPanel agents', async () => {
    const f = fixture({ type: 'CPANEL' });
    const res = await f.service.register(input({ agentType: 'CPANEL', publicKey: undefined }), ctx);
    expect(res.keyFingerprint).toBeNull();
  });
});
