/* eslint-disable @typescript-eslint/no-unused-vars */
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';

// Full enqueue/cancelPending logic lands in Checkpoint D — needs the Scan
// Prisma model (Checkpoint B) to exist first. This stub only proves the
// queue is reachable from app-side code.
@Injectable()
export class ScanQueueService {
  constructor(@InjectQueue('scan') private readonly scanQueue: Queue) {}

  // TODO Checkpoint D: cancelPending(repoId, prNumber) → upsert `scans` row
  // (dedupe-by-sha for webhook / attempt+1 for rescan) → queue.add(...)
  enqueue(_dto: unknown): Promise<void> {
    throw new Error(
      'ScanQueueService.enqueue not implemented yet (Checkpoint D)',
    );
  }

  // TODO Checkpoint D: queue.getJobs(['waiting','delayed']), filter by
  // jobId prefix scan:{repoId}:{prNumber}:, remove matches, mark
  // corresponding `scans` rows SUPERSEDED.
  cancelPending(_repoId: string, _prNumber: string): Promise<void> {
    throw new Error(
      'ScanQueueService.cancelPending not implemented yet (Checkpoint D)',
    );
  }
}
