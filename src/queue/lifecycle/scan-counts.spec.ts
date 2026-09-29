import Redis from 'ioredis';
import { Logger } from 'winston';
import {
  FindingSeverity,
  FindingSource,
  FindingStatus,
} from '../../generated/prisma/enums';
import {
  notifyIfAllCriticalResolved,
  recomputeScanCounts,
} from './scan-counts';

function group(
  status: FindingStatus,
  severity: FindingSeverity,
  source: FindingSource,
  n: number,
) {
  return { status, severity, source, _count: { _all: n } };
}

describe('recomputeScanCounts', () => {
  it('counts active findings by severity and status, never resolved ones', async () => {
    const tx = {
      finding: {
        groupBy: jest
          .fn()
          .mockResolvedValue([
            group(
              FindingStatus.PERSISTED,
              FindingSeverity.CRITICAL,
              FindingSource.STATIC,
              1,
            ),
            group(
              FindingStatus.PERSISTED,
              FindingSeverity.MAJOR,
              FindingSource.AI,
              1,
            ),
            group(
              FindingStatus.REOPENED,
              FindingSeverity.CRITICAL,
              FindingSource.AI,
              1,
            ),
            group(
              FindingStatus.RESOLVED,
              FindingSeverity.CRITICAL,
              FindingSource.STATIC,
              2,
            ),
            group(
              FindingStatus.RESOLVED,
              FindingSeverity.CRITICAL,
              FindingSource.AI,
              1,
            ),
          ]),
        // One of the resolved rows was re-opened within this scan.
        count: jest.fn().mockResolvedValue(1),
      },
      scan: { update: jest.fn() },
    };

    const counts = await recomputeScanCounts(tx as never, 'scan_2');

    expect(counts).toEqual({
      findingsCount: 1,
      criticalCount: 2,
      majorCount: 1,
      minorCount: 0,
      newCount: 0,
      persistedCount: 2,
      reopenedCount: 1,
      resolvedCount: 2,
    });
    expect(tx.scan.update).toHaveBeenCalledWith({
      where: { id: 'scan_2' },
      data: counts,
    });
  });
});

// Acceptance 10.
describe('notifyIfAllCriticalResolved', () => {
  function setup(resolvedCritical: number) {
    const prisma = {
      finding: { count: jest.fn().mockResolvedValue(resolvedCritical) },
    };
    const redis = { set: jest.fn().mockResolvedValue('OK') };
    const logger = { info: jest.fn() };
    const notify = (criticalCount: number) =>
      notifyIfAllCriticalResolved(
        prisma,
        redis as unknown as Redis,
        logger as unknown as Logger,
        { id: 'scan_2', headSha: 'a1b2c3d4e5', criticalCount },
        { pullId: 'pull_1' },
      );
    return { notify, redis, logger };
  }

  it('notifies once when the last criticals were resolved', async () => {
    const { notify, redis, logger } = setup(3);
    await notify(0);
    expect(logger.info).toHaveBeenCalledWith(
      'notification.pull_critical_resolved',
      expect.objectContaining({ resolvedCritical: 3, headSha: 'a1b2c3d' }),
    );
    redis.set.mockResolvedValue(null);
    logger.info.mockClear();
    await notify(0);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('stays silent while a critical remains or nothing was resolved', async () => {
    const remaining = setup(1);
    await remaining.notify(1);
    expect(remaining.logger.info).not.toHaveBeenCalled();

    const nothing = setup(0);
    await nothing.notify(0);
    expect(nothing.logger.info).not.toHaveBeenCalled();
  });
});
