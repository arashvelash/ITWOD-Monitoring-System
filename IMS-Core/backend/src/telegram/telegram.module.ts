import { Module } from '@nestjs/common';
import { BackupsModule } from '../backups/backups.module';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramCommandsService } from './telegram-commands.service';
import { TelegramController } from './telegram.controller';
import { TelegramLinksService } from './telegram-links.service';

@Module({
  imports: [BackupsModule],
  controllers: [TelegramController],
  providers: [TelegramLinksService, TelegramCommandsService, TelegramBotService],
  exports: [TelegramLinksService, TelegramBotService],
})
export class TelegramModule {}
