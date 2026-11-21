import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedNode } from '../common/types/request';
import { PrismaService } from '../prisma/prisma.service';
import { AGENT_DEFAULTS, WS_CLOSE } from './agent.constants';
import { AgentConfigService } from './agent-config.service';
import { AgentEventsService } from './agent-events.service';
import { CommandsService } from './commands.service';
import { ConnectionRegistry } from './connection-registry';
import { NodeAuthService } from './node-auth.service';

interface SocketState {
  node?: AuthenticatedNode;
  alive: boolean;
  missedPongs: number;
  windowStart: number;
  messages: number;
  ip: string;
}

/** Frames whose payload lives in `data`; for the others the frame itself is the payload. */
const DATA_FRAMES = new Set(['metrics', 'backup.report']);

/**
 * Agent WebSocket gateway (wss://<core>/ws/agent).
 * Attached directly to the HTTP server with `noServer` so the auth handshake,
 * frame limits and flood protection are fully under our control.
 */
@Injectable()
export class AgentGatewayService implements OnApplicationShutdown {
  private readonly logger = new Logger(AgentGatewayService.name);
  private wss?: WebSocketServer;
  private pingTimer?: NodeJS.Timeout;
  private readonly states = new WeakMap<WebSocket, SocketState>();

  constructor(
    private readonly nodeAuth: NodeAuthService,
    private readonly registry: ConnectionRegistry,
    private readonly events: AgentEventsService,
    private readonly commands: CommandsService,
    private readonly agentConfig: AgentConfigService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  attach(server: HttpServer): void {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: AGENT_DEFAULTS.maxFrameBytes, perMessageDeflate: false });
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path !== AGENT_DEFAULTS.wsPath) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
    });
    this.pingTimer = setInterval(() => this.pingAll(), AGENT_DEFAULTS.pingIntervalMs);
    this.pingTimer.unref();
    this.logger.log(`Agent gateway listening on ${AGENT_DEFAULTS.wsPath}`);
  }

  onApplicationShutdown(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const c of this.registry.all()) c.socket.close(1001, 'Core shutting down');
    this.wss?.close();
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
    const state: SocketState = { alive: true, missedPongs: 0, windowStart: Date.now(), messages: 0, ip: (forwarded || req.socket.remoteAddress || '').slice(0, 64) };
    this.states.set(ws, state);

    const authTimer = setTimeout(() => {
      if (!state.node) ws.close(WS_CLOSE.unauthorized, 'Authentication timeout');
    }, AGENT_DEFAULTS.authTimeoutMs);

    ws.on('pong', () => (state.alive = true));
    ws.on('message', (raw: RawData, isBinary: boolean) => {
      void this.onMessage(ws, state, raw, isBinary).catch((err: Error) => {
        this.logger.warn(`Error handling frame from ${state.node?.nodeId ?? state.ip}: ${err.message}`);
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', code: 'BAD_FRAME', message: 'Frame rejected' }));
      });
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      if (state.node) {
        this.registry.remove(state.node.serverId, ws);
        this.logger.log(`Node ${state.node.nodeId} disconnected`);
      }
    });
    ws.on('error', (err) => this.logger.debug(`Socket error: ${err.message}`));
  }

  private async onMessage(ws: WebSocket, state: SocketState, raw: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) {
      ws.close(WS_CLOSE.badMessage, 'Binary frames are not supported');
      return;
    }
    const now = Date.now();
    if (now - state.windowStart > AGENT_DEFAULTS.messageWindowMs) {
      state.windowStart = now;
      state.messages = 0;
    }
    if (++state.messages > AGENT_DEFAULTS.maxMessagesPerWindow) {
      ws.close(WS_CLOSE.flood, 'Too many messages');
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    } catch {
      ws.close(WS_CLOSE.badMessage, 'Invalid JSON');
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      ws.close(WS_CLOSE.badMessage, 'Invalid frame');
      return;
    }

    if (!state.node) {
      await this.authenticate(ws, state, msg);
      return;
    }

    const { type, ...rest } = msg;
    const payload = DATA_FRAMES.has(type as string) ? rest.data : rest;
    await this.events.dispatch(state.node, type as string, payload);
    if (type === 'heartbeat') {
      ws.send(JSON.stringify({ type: 'heartbeat.ack', serverTime: Math.floor(Date.now() / 1000), configVersion: await this.agentConfig.currentVersion(state.node.serverId) }));
    }
  }

  private async authenticate(ws: WebSocket, state: SocketState, msg: Record<string, unknown>): Promise<void> {
    if (msg.type !== 'auth') {
      ws.close(WS_CLOSE.unauthorized, 'Authentication required');
      return;
    }
    let node: AuthenticatedNode;
    try {
      node = await this.nodeAuth.verifyWsAuth(msg);
    } catch {
      await this.audit.record({ actorType: 'NODE', actorId: typeof msg.nodeId === 'string' ? msg.nodeId.slice(0, 64) : null, action: 'node.ws_auth', success: false, context: { ip: state.ip, userAgent: null } });
      ws.close(WS_CLOSE.unauthorized, 'Authentication failed');
      return;
    }
    state.node = node;
    const agentVersion = typeof msg.agentVersion === 'string' ? msg.agentVersion.slice(0, 32) : undefined;
    const replaced = this.registry.set({ serverId: node.serverId, nodeId: node.nodeId, socket: ws, connectedAt: new Date(), agentVersion, remoteAddress: state.ip });
    if (replaced) replaced.socket.close(WS_CLOSE.replaced, 'Replaced by a newer connection');

    await this.prisma.server.update({ where: { id: node.serverId }, data: { ipAddress: state.ip || undefined } });
    await this.events.heartbeat(node, { agentVersion });

    ws.send(
      JSON.stringify({
        type: 'auth.ok',
        serverTime: Math.floor(Date.now() / 1000),
        heartbeatIntervalSec: AGENT_DEFAULTS.heartbeatIntervalSec,
        metricsIntervalSec: AGENT_DEFAULTS.metricsIntervalSec,
        configVersion: await this.agentConfig.currentVersion(node.serverId),
      }),
    );
    this.logger.log(`Node ${node.nodeId} connected from ${state.ip}`);
    const delivered = await this.commands.deliverPending(node.serverId);
    if (delivered) this.logger.log(`Delivered ${delivered} pending command(s) to ${node.nodeId}`);
  }

  private pingAll(): void {
    for (const conn of this.registry.all()) {
      const state = this.states.get(conn.socket);
      if (!state) continue;
      state.missedPongs = state.alive ? 0 : state.missedPongs + 1;
      if (state.missedPongs >= 2) {
        conn.socket.terminate();
        this.registry.remove(conn.serverId, conn.socket);
        continue;
      }
      state.alive = false;
      conn.socket.ping();
    }
  }
}
