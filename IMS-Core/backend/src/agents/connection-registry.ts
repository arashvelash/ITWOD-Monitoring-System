import { Injectable } from '@nestjs/common';
import type { WebSocket } from 'ws';

export interface AgentConnection {
  serverId: string;
  nodeId: string;
  socket: WebSocket;
  connectedAt: Date;
  agentVersion?: string;
  remoteAddress?: string;
}

/**
 * In-memory registry of live agent WebSocket sessions.
 * Kept dependency-free so both the gateway and the command service can use it
 * without circular dependencies.
 */
@Injectable()
export class ConnectionRegistry {
  private readonly connections = new Map<string, AgentConnection>();

  get(serverId: string): AgentConnection | undefined {
    return this.connections.get(serverId);
  }

  isConnected(serverId: string): boolean {
    const c = this.connections.get(serverId);
    return Boolean(c && c.socket.readyState === c.socket.OPEN);
  }

  /** Registers a connection and returns the one it replaces, if any. */
  set(conn: AgentConnection): AgentConnection | undefined {
    const previous = this.connections.get(conn.serverId);
    this.connections.set(conn.serverId, conn);
    return previous && previous.socket !== conn.socket ? previous : undefined;
  }

  remove(serverId: string, socket: WebSocket): void {
    if (this.connections.get(serverId)?.socket === socket) this.connections.delete(serverId);
  }

  send(serverId: string, message: unknown): boolean {
    const c = this.connections.get(serverId);
    if (!c || c.socket.readyState !== c.socket.OPEN) return false;
    c.socket.send(JSON.stringify(message));
    return true;
  }

  disconnect(serverId: string, code: number, reason: string): void {
    const c = this.connections.get(serverId);
    if (c) {
      c.socket.close(code, reason);
      this.connections.delete(serverId);
    }
  }

  connectedIds(): string[] {
    return [...this.connections.keys()].filter((id) => this.isConnected(id));
  }

  all(): AgentConnection[] {
    return [...this.connections.values()];
  }
}
