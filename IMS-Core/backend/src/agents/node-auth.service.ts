import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { ServerType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SecretBoxService } from '../crypto/secret-box.service';
import { NonceStore } from '../redis/nonce.store';
import { canonicalHttpRequest, canonicalWsAuth, isTimestampFresh, PROTOCOL, verifyEd25519, verifyHmacHex } from '../crypto/node-protocol';
import type { AuthenticatedNode } from '../common/types/request';

export interface SignedHttpRequest {
  method: string;
  path: string;
  body: Buffer | string;
  headers: {
    nodeId?: string;
    timestamp?: string;
    nonce?: string;
    signature?: string;
    keySignature?: string;
  };
}

export interface WsAuthMessage {
  nodeId?: unknown;
  ts?: unknown;
  nonce?: unknown;
  signature?: unknown;
  keySignature?: unknown;
}

interface NodeRecord {
  serverId: string;
  nodeId: string;
  type: ServerType;
  secret: string;
  publicKey: string | null;
}

const GENERIC = 'Node authentication failed';
const NODE_ID_PATTERN = /^ims-node-\d{4,}$/;

/**
 * Verifies agent identity (docs/PROTOCOL.md §3, §4.1):
 * HMAC-SHA256 with the node secret + Ed25519 key signature + timestamp window +
 * one-time nonce. All failures return the same generic error.
 */
@Injectable()
export class NodeAuthService {
  private readonly logger = new Logger(NodeAuthService.name);
  private readonly lastUsedWrites = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly secretBox: SecretBoxService,
    private readonly nonces: NonceStore,
  ) {}

  async verifyHttp(req: SignedHttpRequest): Promise<AuthenticatedNode> {
    const { nodeId, timestamp, nonce, signature, keySignature } = req.headers;
    if (!nodeId || !timestamp || !nonce || !signature) throw new UnauthorizedException(GENERIC);
    const ts = Number(timestamp);
    if (!/^\d{1,12}$/.test(timestamp)) throw new UnauthorizedException(GENERIC);
    const canonical = canonicalHttpRequest(req.method, req.path, ts, nonce, req.body ?? '');
    return this.verify(nodeId, ts, nonce, canonical, signature, keySignature, 'http');
  }

  async verifyWsAuth(msg: WsAuthMessage): Promise<AuthenticatedNode> {
    const { nodeId, ts, nonce, signature, keySignature } = msg;
    if (typeof nodeId !== 'string' || typeof ts !== 'number' || typeof nonce !== 'string' || typeof signature !== 'string') {
      throw new UnauthorizedException(GENERIC);
    }
    const canonical = canonicalWsAuth(nodeId, ts, nonce);
    return this.verify(nodeId, ts, nonce, canonical, signature, typeof keySignature === 'string' ? keySignature : undefined, 'ws');
  }

  private async verify(nodeId: string, ts: number, nonce: string, canonical: string, signature: string, keySignature: string | undefined, channel: 'http' | 'ws'): Promise<AuthenticatedNode> {
    if (!NODE_ID_PATTERN.test(nodeId) || !PROTOCOL.noncePattern.test(nonce) || !isTimestampFresh(ts)) {
      throw new UnauthorizedException(GENERIC);
    }
    const node = await this.loadNode(nodeId);
    if (!node) throw new UnauthorizedException(GENERIC);

    if (!verifyHmacHex(node.secret, canonical, signature)) {
      this.logger.warn(`Invalid HMAC from ${nodeId} (${channel})`);
      throw new UnauthorizedException(GENERIC);
    }
    if (node.publicKey && (!keySignature || !verifyEd25519(node.publicKey, canonical, keySignature))) {
      this.logger.warn(`Invalid key signature from ${nodeId} (${channel})`);
      throw new UnauthorizedException(GENERIC);
    }
    // Claim the nonce only after the signature is valid, so unauthenticated
    // clients cannot burn nonces or fill Redis.
    if (!(await this.nonces.claim(nodeId, nonce, PROTOCOL.nonceTtlSec))) {
      this.logger.warn(`Replayed nonce from ${nodeId} (${channel})`);
      throw new UnauthorizedException(GENERIC);
    }
    this.touch(node.serverId);
    return { serverId: node.serverId, nodeId: node.nodeId, type: node.type, secret: node.secret };
  }

  /** Loads the node with its decrypted secret, or null if it may not authenticate. */
  async loadNode(nodeId: string): Promise<NodeRecord | null> {
    const server = await this.prisma.server.findUnique({ where: { nodeId }, include: { credential: true } });
    if (!server?.credential || server.credential.revokedAt) return null;
    if (server.status === 'REVOKED' || server.status === 'DECOMMISSIONED' || server.status === 'PENDING') return null;
    let secret: string;
    try {
      secret = this.secretBox.decrypt(server.credential.secretEncrypted, `node-secret:${server.id}`);
    } catch {
      this.logger.error(`Cannot decrypt credential of ${nodeId}; was the master key changed?`);
      return null;
    }
    return { serverId: server.id, nodeId: server.nodeId, type: server.type, secret, publicKey: server.credential.publicKey };
  }

  /** Returns the decrypted secret for signing commands to a node. */
  async secretFor(serverId: string): Promise<string | null> {
    const cred = await this.prisma.nodeCredential.findUnique({ where: { serverId } });
    if (!cred || cred.revokedAt) return null;
    return this.secretBox.decrypt(cred.secretEncrypted, `node-secret:${serverId}`);
  }

  private touch(serverId: string) {
    const now = Date.now();
    if ((this.lastUsedWrites.get(serverId) ?? 0) > now - 60_000) return;
    this.lastUsedWrites.set(serverId, now);
    void this.prisma.nodeCredential.update({ where: { serverId }, data: { lastUsedAt: new Date(now) } }).catch(() => undefined);
  }
}
