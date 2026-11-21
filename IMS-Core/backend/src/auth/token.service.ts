import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { UserRole } from '@prisma/client';
import { APP_CONFIG, AppConfig } from '../config/app-config';

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  role: UserRole;
  typ: 'access';
  iat?: number;
  exp?: number;
}

const ISSUER = 'ims-core';
const AUDIENCE = 'ims-dashboard';

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get accessTtlSec(): number {
    return this.config.accessTokenTtlSec;
  }

  signAccessToken(userId: string, sessionId: string, role: UserRole): string {
    const claims: AccessTokenClaims = { sub: userId, sid: sessionId, role, typ: 'access' };
    return this.jwt.sign(claims, {
      secret: this.config.jwtAccessSecret,
      algorithm: 'HS256',
      expiresIn: this.config.accessTokenTtlSec,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  }

  /** Throws when the token is invalid, expired or not an access token. */
  verifyAccessToken(token: string): AccessTokenClaims {
    const claims = this.jwt.verify<AccessTokenClaims>(token, {
      secret: this.config.jwtAccessSecret,
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (claims.typ !== 'access' || !claims.sub || !claims.sid) {
      throw new Error('Invalid token type');
    }
    return claims;
  }
}
