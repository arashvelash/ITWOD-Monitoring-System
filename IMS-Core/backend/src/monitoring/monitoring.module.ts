import { Controller, Get, Module, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { MonitoringService } from './monitoring.service';
import { RANGES } from './metrics.schema';

const rangeSchema = z.object({ range: z.enum(Object.keys(RANGES) as [keyof typeof RANGES, ...(keyof typeof RANGES)[]]).default('24h') });

@Controller('servers')
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Get(':id/metrics')
  metrics(@Param('id', new ParseUUIDPipe()) id: string, @Query(new ZodValidationPipe(rangeSchema)) q: z.infer<typeof rangeSchema>) {
    return this.monitoring.history(id, q.range);
  }
}

@Module({
  controllers: [MonitoringController],
  providers: [MonitoringService],
  exports: [MonitoringService],
})
export class MonitoringModule {}
