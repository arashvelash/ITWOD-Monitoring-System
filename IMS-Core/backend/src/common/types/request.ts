import type { ServerType, UserRole } from '@prisma/client';

/** Authenticated dashboard user attached to the request by JwtAuthGuard. */
export interface AuthUser {
  id: string;
  username: string;
  displayName: string | null;
  role: UserRole;
  sessionId: string;
  mustChangePassword: boolean;
}

/** Authenticated agent attached to the request by AgentAuthGuard. */
export interface AuthenticatedNode {
  serverId: string;
  nodeId: string;
  type: ServerType;
  /** Decrypted node secret, kept in memory only for the lifetime of the request. */
  secret: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      node?: AuthenticatedNode;
      rawBody?: Buffer;
    }
  }
}

export {};
