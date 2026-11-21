import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ServerType } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { SecretBoxService } from '../crypto/secret-box.service';
import { generateToken, sha256Hex, TOKEN_PREFIX } from '../crypto/tokens';
import { ed25519Fingerprint, parseEd25519PublicKey } from '../crypto/node-protocol';
import { AuditService } from '../audit/audit.service';
import type { ClientContext } from '../common/utils/request-context';
import { AGENT_DEFAULTS } from './agent.constants';

export const registerSchema = z
  .object({
    registrationToken: z.string().regex(/^imsr_[A-Za-z0-9_-]{32}$/, 'Invalid registration token format'),
    publicKey: z.string().max(64).optional(),
    agentType: z.nativeEnum(ServerType),
    agentVersion: z.string().regex(/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/).max(32),
    hostname: z.string().trim().min(1).max(255),
    os: z.string().trim().max(255).optional(),
    arch: z.string().trim().max(32).optional(),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;

const INVALID = 'Invalid or expired registration token';

@Injectable()
export class AgentRegistrationService {
  private readonly logger = new Logger(AgentRegistrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secretBox: SecretBoxService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Consumes a one-time registration token and issues the permanent node
   * credential. The token is claimed with a conditional UPDATE so it can be
   * used exactly once even under concurrent requests.
   */
  async register(input: RegisterInput, ctx: ClientContext) {
    const tokenHash = sha256Hex(input.registrationToken);
    const token = await this.prisma.registrationToken.findUnique({ where: { tokenHash }, include: { server: true } });
    const now = new Date();

    if (!token || token.usedAt || token.revokedAt || token.expiresAt <= now) {
      await this.audit.record({ actorType: 'NODE', action: 'node.register', success: false, metadata: { reason: 'invalid_token', hostname: input.hostname }, context: ctx });
      throw new UnauthorizedException(INVALID);
    }
    const server = token.server;
    if (server.status === 'DECOMMISSIONED') throw new UnauthorizedException(INVALID);
    if (server.type !== input.agentType) {
      throw new BadRequestException(`This server was created as ${server.type}; install the matching agent`);
    }

    let publicKey: string | null = null;
    let fingerprint: string | null = null;
    if (input.publicKey) {
      if (!parseEd25519PublicKey(input.publicKey)) throw new BadRequestException('publicKey must be a base64 raw Ed25519 key');
      publicKey = input.publicKey;
      fingerprint = ed25519Fingerprint(publicKey);
    } else if (server.type === 'UBUNTU') {
      throw new BadRequestException('publicKey is required for Ubuntu agents');
    }

    const nodeSecret = generateToken(TOKEN_PREFIX.nodeSecret, 32);
    const secretEncrypted = this.secretBox.encrypt(nodeSecret, `node-secret:${server.id}`);

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.registrationToken.updateMany({
        where: { id: token.id, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now, usedByIp: ctx.ip },
      });
      if (claimed.count !== 1) throw new UnauthorizedException(INVALID);
      // Any other outstanding token for this server becomes invalid as well.
      await tx.registrationToken.updateMany({ where: { serverId: server.id, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
      await tx.nodeCredential.upsert({
        where: { serverId: server.id },
        create: { serverId: server.id, secretEncrypted, publicKey, keyFingerprint: fingerprint, keyAlgorithm: publicKey ? 'ed25519' : null },
        update: { secretEncrypted, publicKey, keyFingerprint: fingerprint, keyAlgorithm: publicKey ? 'ed25519' : null, issuedAt: now, revokedAt: null, lastUsedAt: null },
      });
      await tx.server.update({
        where: { id: server.id },
        data: {
          status: 'OFFLINE',
          registeredAt: now,
          hostname: input.hostname,
          osDetails: input.os ?? null,
          arch: input.arch ?? null,
          agentVersion: input.agentVersion,
          ipAddress: ctx.ip,
          configVersion: { increment: 1 },
        },
      });
    });

    await this.audit.record({
      actorType: 'NODE',
      actorId: server.nodeId,
      actorName: input.hostname,
      action: 'node.register',
      targetType: 'server',
      targetId: server.id,
      metadata: { agentVersion: input.agentVersion, keyFingerprint: fingerprint, hmacOnly: !publicKey },
      context: ctx,
    });
    this.logger.log(`Node ${server.nodeId} registered from ${ctx.ip} (${input.hostname})`);

    return {
      nodeId: server.nodeId,
      nodeSecret,
      keyFingerprint: fingerprint,
      heartbeatIntervalSec: AGENT_DEFAULTS.heartbeatIntervalSec,
      metricsIntervalSec: AGENT_DEFAULTS.metricsIntervalSec,
      wsPath: AGENT_DEFAULTS.wsPath,
    };
  }
}
