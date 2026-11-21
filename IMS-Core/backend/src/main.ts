import 'reflect-metadata';
import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadConfig } from './config/app-config';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { applyHttpHardening } from './common/http/hardening';
import { AgentGatewayService } from './agents/agent-gateway.service';

const LEVELS: LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];

async function bootstrap(): Promise<void> {
  // Validate configuration before anything else so misconfiguration fails fast and clearly.
  const config = loadConfig();
  const logger = new ConsoleLogger({
    json: config.isProduction,
    colors: !config.isProduction,
    logLevels: LEVELS.slice(0, LEVELS.indexOf(config.logLevel) + 1),
  });

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger });

  applyHttpHardening(app, config);
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '2mb' });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  // Agent WebSocket gateway shares the HTTP server (wss://<core>/ws/agent via Caddy).
  app.get(AgentGatewayService).attach(app.getHttpServer());

  await app.listen(config.port, config.host);
  logger.log(`IMS-Core ${config.version} listening on ${config.host}:${config.port} (${config.env})`, 'Bootstrap');
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
