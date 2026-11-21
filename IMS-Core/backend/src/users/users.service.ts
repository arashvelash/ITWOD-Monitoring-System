import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import { AuthService, toPublicUser } from '../auth/auth.service';
import { checkPasswordPolicy } from '../auth/password-policy';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/types/request';
import type { ClientContext } from '../common/utils/request-context';
import type { CreateUserInput, UpdateUserInput } from './users.schemas';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const users = await this.prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
    return users.map((u) => ({ ...toPublicUser(u), isActive: u.isActive, lockedUntil: u.lockedUntil }));
  }

  async create(input: CreateUserInput, actor: AuthUser, ctx: ClientContext) {
    this.assertPassword(input.password, input.username);
    try {
      const user = await this.prisma.user.create({
        data: {
          username: input.username,
          displayName: input.displayName ?? null,
          email: input.email ?? null,
          role: input.role,
          passwordHash: await this.passwords.hash(input.password),
          mustChangePassword: input.mustChangePassword ?? true,
        },
      });
      await this.audit.byUser(actor, 'user.create', { type: 'user', id: user.id }, { username: user.username, role: user.role }, ctx);
      return toPublicUser(user);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Username or e-mail already in use');
      }
      throw err;
    }
  }

  async update(id: string, input: UpdateUserInput, actor: AuthUser, ctx: ClientContext) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    const demoting = input.role !== undefined && input.role !== UserRole.ADMIN && user.role === UserRole.ADMIN;
    const disabling = input.isActive === false && user.isActive;
    if ((demoting || disabling) && user.role === UserRole.ADMIN) {
      await this.assertAnotherActiveAdmin(user.id);
    }
    if (id === actor.id && (demoting || disabling)) {
      throw new BadRequestException('You cannot demote or disable your own account');
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    if (disabling || (input.role !== undefined && input.role !== user.role)) {
      await this.auth.revokeAllSessions(id, disabling ? 'user_disabled' : 'role_changed');
    }
    await this.audit.byUser(actor, 'user.update', { type: 'user', id }, { changes: Object.keys(input) }, ctx);
    return { ...toPublicUser(updated), isActive: updated.isActive };
  }

  async resetPassword(id: string, newPassword: string, actor: AuthUser, ctx: ClientContext): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    this.assertPassword(newPassword, user.username);
    await this.prisma.user.update({
      where: { id },
      data: { passwordHash: await this.passwords.hash(newPassword), mustChangePassword: true, passwordChangedAt: new Date(), failedLoginAttempts: 0, lockedUntil: null },
    });
    await this.auth.revokeAllSessions(id, 'password_reset');
    await this.audit.byUser(actor, 'user.password_reset', { type: 'user', id }, undefined, ctx);
  }

  async unlock(id: string, actor: AuthUser, ctx: ClientContext): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { failedLoginAttempts: 0, lockedUntil: null } });
    await this.audit.byUser(actor, 'user.unlock', { type: 'user', id }, undefined, ctx);
  }

  private assertPassword(password: string, username: string) {
    const policy = checkPasswordPolicy(password, username);
    if (!policy.ok) {
      throw new BadRequestException({ message: 'Password does not meet the policy', errors: policy.errors.map((m) => ({ path: 'password', message: m })) });
    }
  }

  private async assertAnotherActiveAdmin(excludeId: string) {
    const others = await this.prisma.user.count({ where: { role: UserRole.ADMIN, isActive: true, id: { not: excludeId } } });
    if (others === 0) throw new BadRequestException('At least one active administrator must remain');
  }
}
