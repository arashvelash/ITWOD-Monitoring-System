import { EventEmitter } from 'node:events';
import type { KeyObject } from 'node:crypto';
import WebSocket from 'ws';
import { createLogger } from './logger';
import { canonicalWsAuth, hmacHex, newNonce, signEd25519 } from './protocol';
import { AGENT_VERSION } from './version';

const log = createLogger('ws');

export interface WsClientOptions {
  url: string;
  nodeId: string;
  nodeSecret: string;
  privateKey: KeyObject;
  /** Reconnect back-off bounds. */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Consider the link dead when nothing arrives for this long. */
  idleTimeoutMs?: number;
}

export interface AuthOk {
  type: 'auth.ok';
  serverTime: number;
  heartbeatIntervalSec: number;
  metricsIntervalSec: number;
  configVersion: number;
}

/**
 * Persistent, self-healing WebSocket connection to Core.
 * Emits: 'authenticated' (AuthOk), 'message' (frame), 'disconnected' (code).
 */
export class WsClient extends EventEmitter {
  private ws?: WebSocket;
  private attempt = 0;
  private stopped = false;
  private reconnectTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private authenticated = false;

  constructor(private readonly opts: WsClientOptions) {
    super();
  }

  get connected(): boolean {
    return this.authenticated && this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.idleTimer);
    this.ws?.close(1000, 'agent stopping');
  }

  send(frame: Record<string, unknown>): boolean {
    if (!this.connected) return false;
    this.ws!.send(JSON.stringify(frame));
    return true;
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.opts.url, { handshakeTimeout: 15_000, maxPayload: 1024 * 1024, perMessageDeflate: false, headers: { 'User-Agent': `ims-agent/${AGENT_VERSION}` } });
    this.ws = ws;
    this.authenticated = false;

    ws.on('open', () => {
      const ts = Math.floor(Date.now() / 1000);
      const nonce = newNonce();
      const canonical = canonicalWsAuth(this.opts.nodeId, ts, nonce);
      ws.send(
        JSON.stringify({
          type: 'auth',
          nodeId: this.opts.nodeId,
          ts,
          nonce,
          signature: hmacHex(this.opts.nodeSecret, canonical),
          keySignature: signEd25519(this.opts.privateKey, canonical),
          agentVersion: AGENT_VERSION,
        }),
      );
      this.bumpIdle();
    });

    ws.on('ping', () => this.bumpIdle());
    ws.on('message', (data, isBinary) => {
      this.bumpIdle();
      if (isBinary) return;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      } catch {
        log.warn('Ignoring non-JSON frame from Core');
        return;
      }
      if (frame.type === 'auth.ok') {
        this.authenticated = true;
        this.attempt = 0;
        log.info('Connected to Core');
        this.emit('authenticated', frame as unknown as AuthOk);
        return;
      }
      this.emit('message', frame);
    });

    ws.on('close', (code, reason) => {
      clearTimeout(this.idleTimer);
      const wasAuthenticated = this.authenticated;
      this.authenticated = false;
      this.emit('disconnected', code);
      if (this.stopped) return;
      log.warn('Disconnected from Core', { code, reason: reason.toString(), wasAuthenticated });
      this.scheduleReconnect(code);
    });

    ws.on('error', (err) => log.debug('WebSocket error', { error: err.message }));
  }

  private scheduleReconnect(code: number): void {
    const min = this.opts.minDelayMs ?? 1_000;
    const max = this.opts.maxDelayMs ?? 60_000;
    this.attempt++;
    let delay = Math.min(max, min * 2 ** Math.min(this.attempt, 10));
    // Credential problems will not fix themselves quickly: back off harder.
    if (code === 4401 || code === 4403) delay = Math.max(delay, 5 * 60_000);
    if (code === 4409) delay = Math.max(delay, 30_000);
    delay = Math.round(delay * (0.8 + Math.random() * 0.4));
    if (code === 4403) log.error('Core revoked this node. Re-register the agent with a new registration token.');
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref?.();
  }

  private bumpIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      log.warn('Connection idle, reconnecting');
      this.ws?.terminate();
    }, this.opts.idleTimeoutMs ?? 90_000);
    this.idleTimer.unref?.();
  }
}
