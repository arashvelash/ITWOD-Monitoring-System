import { Body, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req, ConflictException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import type { Request } from 'express';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, RequireRole } from '../common/decorators/auth.decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import type { AuthUser } from '../common/types/request';
import { getClientContext } from '../common/utils/request-context';
import { slugify } from '../common/utils/slug';

const projectSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    description: z.string().trim().max(2000).nullable().optional(),
    websiteUrl: z.string().url().max(512).nullable().optional(),
    serverId: z.string().uuid().nullable().optional(),
  })
  .strict();
const updateSchema = projectSchema.partial().extend({ archived: z.boolean().optional() }).strict();
type ProjectInput = z.infer<typeof projectSchema>;
type ProjectUpdate = z.infer<typeof updateSchema>;

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(includeArchived: boolean) {
    return this.prisma.project.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      orderBy: { name: 'asc' },
      include: { server: { select: { id: true, name: true, nodeId: true } }, _count: { select: { jobs: { where: { archivedAt: null } } } } },
    });
  }

  async get(id: string) {
    const project = await this.prisma.project.findUnique({
      where: { id },
      include: { server: { select: { id: true, name: true, nodeId: true } }, jobs: { where: { archivedAt: null }, orderBy: { name: 'asc' } } },
    });
    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  async create(input: ProjectInput, actor: AuthUser, req: Request) {
    const base = slugify(input.name);
    for (let i = 0; i < 20; i++) {
      const slug = i === 0 ? base : `${base}-${i + 1}`;
      try {
        const project = await this.prisma.project.create({
          data: { name: input.name, slug, description: input.description ?? null, websiteUrl: input.websiteUrl ?? null, serverId: input.serverId ?? null },
        });
        await this.audit.byUser(actor, 'project.create', { type: 'project', id: project.id }, { name: project.name }, getClientContext(req));
        return project;
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      }
    }
    throw new ConflictException('Could not allocate a unique project slug');
  }

  async update(id: string, input: ProjectUpdate, actor: AuthUser, req: Request) {
    await this.get(id);
    const { archived, ...rest } = input;
    const project = await this.prisma.project.update({
      where: { id },
      data: { ...rest, ...(archived !== undefined ? { archivedAt: archived ? new Date() : null } : {}) },
    });
    await this.audit.byUser(actor, archived ? 'project.archive' : 'project.update', { type: 'project', id }, { fields: Object.keys(input) }, getClientContext(req));
    return project;
  }
}

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list(@Query('includeArchived') includeArchived?: string) {
    return this.projects.list(includeArchived === 'true');
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.projects.get(id);
  }

  @Post()
  @RequireRole(UserRole.OPERATOR)
  create(@Body(new ZodValidationPipe(projectSchema)) body: ProjectInput, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.projects.create(body, user, req);
  }

  @Patch(':id')
  @RequireRole(UserRole.OPERATOR)
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(updateSchema)) body: ProjectUpdate, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.projects.update(id, body, user, req);
  }
}

@Module({ controllers: [ProjectsController], providers: [ProjectsService], exports: [ProjectsService] })
export class ProjectsModule {}
