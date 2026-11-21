import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { CommandService } from '../services/command.service';
import { canonicalCommand, hmacHex, type SignedCommand } from '../src/protocol';
import { tempPaths, vectors } from './helpers';

function signed(command: string, payload: object, id = crypto.randomUUID(), ttl = 60): SignedCommand {
  const issuedAt = Math.floor(Date.now() / 1000);
  const p = JSON.stringify(payload);
  return { type: 'command', id, command, issuedAt, expiresAt: issuedAt + ttl, payload: p, signature: hmacHex(vectors.nodeSecret, canonicalCommand(id, command, issuedAt, issuedAt + ttl, p)) };
}

function setup() {
  const { root } = tempPaths();
  const ack = vi.fn();
  const result = vi.fn().mockResolvedValue(undefined);
  const svc = new CommandService(vectors.nodeSecret, join(root, 'executed.json'), { ack, result });
  return { svc, ack, result, root };
}

describe('CommandService', () => {
  it('executes a signed command once and reports the result', async () => {
    const { svc, ack, result } = setup();
    const handler = vi.fn().mockResolvedValue({ pong: true });
    svc.register('ping', handler);
    const cmd = signed('ping', {});
    await svc.handle(cmd);
    await svc.handle(cmd); // duplicate delivery
    expect(handler).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith(cmd.id);
    expect(result).toHaveBeenCalledWith(cmd.id, 'SUCCEEDED', { pong: true });
  });

  it('never runs commands with an invalid signature and does not answer them', async () => {
    const { svc, result } = setup();
    const handler = vi.fn();
    svc.register('ping', handler);
    await svc.handle({ ...signed('ping', {}), signature: 'a'.repeat(64) });
    expect(handler).not.toHaveBeenCalled();
    expect(result).not.toHaveBeenCalled();
  });

  it('reports failures of handlers and expired commands', async () => {
    const { svc, result } = setup();
    svc.register('config.sync', async () => {
      throw new Error('boom');
    });
    const cmd = signed('config.sync', {});
    await svc.handle(cmd);
    expect(result).toHaveBeenCalledWith(cmd.id, 'FAILED', undefined, 'boom');

    const expired = signed('config.sync', {}, crypto.randomUUID(), -10);
    await svc.handle(expired);
    expect(result).toHaveBeenCalledWith(expired.id, 'FAILED', undefined, 'Rejected by agent: command expired');
  });

  it('persists executed ids across restarts', async () => {
    const { root, ack, result } = setup();
    const file = join(root, 'shared.json');
    const handler = vi.fn().mockResolvedValue(undefined);
    const cmd = signed('ping', {});
    const a = new CommandService(vectors.nodeSecret, file, { ack, result });
    a.register('ping', handler);
    await a.handle(cmd);
    const b = new CommandService(vectors.nodeSecret, file, { ack, result });
    b.register('ping', handler);
    await b.handle(cmd);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
