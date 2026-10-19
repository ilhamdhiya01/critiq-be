import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InvitesController } from './invites.controller';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

// The email queue (QueueModule), RateLimiterService (RedisModule) and the
// realtime publisher come from global modules. Emails are sent by the
// worker (InvitationEmailProcessor), never here.
@Module({
  imports: [AuthModule],
  controllers: [MembersController, InvitesController],
  providers: [MembersService],
})
export class MembersModule {}
