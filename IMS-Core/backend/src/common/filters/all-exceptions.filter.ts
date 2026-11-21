import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
  errors?: unknown;
}

/**
 * Normalises every error into `{ statusCode, error, message, errors? }`.
 * Internal details (stack traces, SQL, Prisma messages) are logged but never
 * returned to the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const body = this.toBody(exception);

    if (body.statusCode >= 500) {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(`${req.method} ${req.originalUrl} -> ${body.statusCode}: ${err.message}`, err.stack);
    }
    if (res.headersSent) return;
    res.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown): ErrorBody {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      if (typeof response === 'string') {
        return { statusCode: status, error: HttpStatus[status] ?? 'Error', message: response };
      }
      const r = response as Record<string, unknown>;
      const message = Array.isArray(r.message) ? r.message.join('; ') : String(r.message ?? exception.message);
      return {
        statusCode: status,
        error: String(r.error ?? HttpStatus[status] ?? 'Error'),
        message,
        ...(r.errors ? { errors: r.errors } : {}),
        ...(r.code ? { code: r.code } : {}),
      } as ErrorBody;
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return { statusCode: 409, error: 'Conflict', message: 'A record with the same unique value already exists' };
      }
      if (exception.code === 'P2025') {
        return { statusCode: 404, error: 'Not Found', message: 'Record not found' };
      }
    }

    return { statusCode: 500, error: 'Internal Server Error', message: 'An unexpected error occurred' };
  }
}
