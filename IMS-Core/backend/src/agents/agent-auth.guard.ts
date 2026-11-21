import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { NodeAuthService } from './node-auth.service';

/** Authenticates signed agent HTTPS requests and attaches `req.node`. */
@Injectable()
export class AgentAuthGuard implements CanActivate {
  constructor(private readonly nodeAuth: NodeAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    req.node = await this.nodeAuth.verifyHttp({
      method: req.method,
      path: req.originalUrl,
      body: req.rawBody ?? '',
      headers: {
        nodeId: req.get('x-ims-node-id'),
        timestamp: req.get('x-ims-timestamp'),
        nonce: req.get('x-ims-nonce'),
        signature: req.get('x-ims-signature'),
        keySignature: req.get('x-ims-key-signature'),
      },
    });
    return true;
  }
}
