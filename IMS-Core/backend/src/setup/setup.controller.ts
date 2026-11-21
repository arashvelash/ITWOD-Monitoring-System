import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../common/decorators/auth.decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { getClientContext } from '../common/utils/request-context';
import { CsrfGuard, CsrfProtected } from '../auth/guards/csrf.guard';
import { SetupService } from './setup.service';
import { SetupInput, setupSchema } from './setup.schemas';

@Controller('setup')
@Public()
@UseGuards(CsrfGuard)
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Get('status')
  status() {
    return this.setup.status();
  }

  @Post('initialize')
  @HttpCode(201)
  @CsrfProtected('origin')
  @Throttle({ default: { limit: 10, ttl: 900_000, blockDuration: 900_000 } })
  initialize(@Body(new ZodValidationPipe(setupSchema)) body: SetupInput, @Req() req: Request) {
    return this.setup.initialize(body, getClientContext(req));
  }
}
