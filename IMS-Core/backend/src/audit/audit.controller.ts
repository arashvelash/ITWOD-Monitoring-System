import { Controller, Get, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { z } from 'zod';
import { RequireRole } from '../common/decorators/auth.decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { paginationSchema } from '../common/utils/request-context';
import { AuditService } from './audit.service';

const querySchema = paginationSchema.extend({
  action: z.string().max(96).optional(),
  actorId: z.string().max(64).optional(),
  targetType: z.string().max(64).optional(),
  targetId: z.string().max(64).optional(),
});

@Controller('audit-logs')
@RequireRole(UserRole.ADMIN)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query(new ZodValidationPipe(querySchema)) q: z.infer<typeof querySchema>) {
    const { page, pageSize, ...filter } = q;
    return this.audit.list(filter, { page, pageSize });
  }
}
