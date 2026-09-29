import type Redis from 'ioredis';
import { Logger } from 'winston';
import { Prisma } from '../../generated/prisma/client';
import {
  FindingSeverity,
  FindingSource,
  FindingStatus,
} from '../../generated/prisma/enums';

const ACTIVE: FindingStatus[] = [
  FindingStatus.NEW,
  FindingStatus.PERSISTED,
  FindingStatus.REOPENED,
];

export interface ScanCounts {
  findingsCount: number;
  criticalCount: number;
  majorCount: number;
  minorCount: number;
  newCount: number;
  persistedCount: number;
  reopenedCount: number;
  resolvedCount: number;
}

type CountClient = Pick<Prisma.TransactionClient, 'finding' | 'scan'>;

// Rebuilds a scan's counts from its finding rows (v1.5.1 langkah 3) — after
// the static step and again after the AI step — instead of adding numbers
// up as each step goes. Suppressed findings never count; RESOLVED never
// counts as active; a RESOLVED row that another finding of the same scan
// re-opened is history, not a resolution, so it leaves resolvedCount too.
export async function recomputeScanCounts(
  tx: CountClient,
  scanId: string,
): Promise<ScanCounts> {
  const groups = await tx.finding.groupBy({
    by: ['status', 'severity', 'source'],
    where: { scanId, suppressedReason: null },
    _count: { _all: true },
  });
  const reopenedWithinScan = await tx.finding.count({
    where: {
      scanId,
      suppressedReason: null,
      status: FindingStatus.REOPENED,
      origin: { scanId, status: FindingStatus.RESOLVED },
    },
  });

  const counts: ScanCounts = {
    findingsCount: 0,
    criticalCount: 0,
    majorCount: 0,
    minorCount: 0,
    newCount: 0,
    persistedCount: 0,
    reopenedCount: 0,
    resolvedCount: 0,
  };
  for (const group of groups) {
    const n = group._count._all;
    if (group.status === FindingStatus.RESOLVED) {
      counts.resolvedCount += n;
      continue;
    }
    if (!ACTIVE.includes(group.status)) {
      continue;
    }
    if (group.status === FindingStatus.NEW) counts.newCount += n;
    if (group.status === FindingStatus.PERSISTED) counts.persistedCount += n;
    if (group.status === FindingStatus.REOPENED) counts.reopenedCount += n;
    if (group.source === FindingSource.STATIC) counts.findingsCount += n;
    if (group.severity === FindingSeverity.CRITICAL) counts.criticalCount += n;
    if (group.severity === FindingSeverity.MAJOR) counts.majorCount += n;
    if (group.severity === FindingSeverity.MINOR) counts.minorCount += n;
  }
  counts.resolvedCount = Math.max(0, counts.resolvedCount - reopenedWithinScan);

  await tx.scan.update({ where: { id: scanId }, data: counts });
  return counts;
}

type NotifyClient = {
  finding: Pick<Prisma.TransactionClient['finding'], 'count'>;
};

// `pull.critical_resolved` — once per scan, when this scan closed critical
// findings and none remain active. Called by whichever step finishes the
// scan last (static when no AI runs, otherwise AI). Log stand-in until the
// notifications module exists.
export async function notifyIfAllCriticalResolved(
  prisma: NotifyClient,
  redis: Redis,
  logger: Logger,
  scan: { id: string; headSha: string; criticalCount: number },
  log: Record<string, unknown>,
): Promise<void> {
  if (scan.criticalCount > 0) {
    return;
  }
  const resolvedCritical = await prisma.finding.count({
    where: {
      scanId: scan.id,
      suppressedReason: null,
      status: FindingStatus.RESOLVED,
      severity: FindingSeverity.CRITICAL,
    },
  });
  if (resolvedCritical === 0) {
    return;
  }
  try {
    const first = await redis.set(
      `notify:critical-resolved:${scan.id}`,
      '1',
      'EX',
      7 * 86_400,
      'NX',
    );
    if (first !== 'OK') {
      return;
    }
  } catch {
    // notify anyway when Redis is unavailable
  }
  logger.info('notification.pull_critical_resolved', {
    ...log,
    resolvedCritical,
    headSha: scan.headSha.slice(0, 7),
  });
}
