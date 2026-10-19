import { Module } from '@nestjs/common';
import { MailService } from './mail.service';

// Imported by the worker only: the app enqueues emails, never sends them.
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
