import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { QueueModule } from './queue.module';

@Module({
  imports: [CommonModule, QueueModule],
})
export class WorkerModule {}
