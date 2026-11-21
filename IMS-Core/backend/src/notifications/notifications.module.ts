import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { NotificationsProcessor } from './notifications.processor';
import { NOTIFICATION_QUEUE, NotificationsService } from './notifications.service';

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: NOTIFICATION_QUEUE }), TelegramModule],
  providers: [NotificationsService, NotificationsProcessor],
  exports: [NotificationsService],
})
export class NotificationsModule {}
