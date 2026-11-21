import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { diskStorage } from 'multer';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { AgentReleasesService, MAX_AGENT_PACKAGE_BYTES } from './agent-releases.service';
import { CoreUpdateService } from './core-update.service';
import { GithubClient } from './github.client';
import { AgentPackagesController, UpdatesController } from './updates.controller';

@Module({
  imports: [
    // Uploads stream to DATA_DIR/tmp (same filesystem as the release store), never into memory.
    MulterModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        storage: diskStorage({
          // Created lazily on first upload (a string destination would be created at boot).
          destination: (_req, _file, cb) => {
            const dir = join(config.dataDir, 'tmp');
            mkdir(dir, { recursive: true, mode: 0o750 }).then(
              () => cb(null, dir),
              (err: Error) => cb(err, dir),
            );
          },
          filename: (_req, _file, cb) => cb(null, `upload-${randomUUID()}.tgz`),
        }),
        limits: { fileSize: MAX_AGENT_PACKAGE_BYTES, files: 1, fields: 4, fieldSize: 64 * 1024 },
      }),
    }),
  ],
  controllers: [UpdatesController, AgentPackagesController],
  providers: [GithubClient, CoreUpdateService, AgentReleasesService],
  exports: [CoreUpdateService, AgentReleasesService],
})
export class UpdatesModule {}
