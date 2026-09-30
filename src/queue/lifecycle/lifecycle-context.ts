import { Logger } from 'winston';
import { Prisma } from '../../generated/prisma/client';
import {
  FindingSource,
  FindingStatus,
  ScanStatus,
} from '../../generated/prisma/enums';
import { StoredFinding } from './plan-findings';
import { REOPEN_WINDOW_SCANS } from './status-matcher';

type Reader = Pick<Prisma.TransactionClient, 'finding' | 'scan'>;

export const STORED_FINDING_SELECT = {
  id: true,
  source: true,
  ruleId: true,
  severity: true,
  title: true,
  message: true,
  filePath: true,
  lineStart: true,
  lineEnd: true,
  snippet: true,
  fingerprint: true,
  suppressedReason: true,
  category: true,
  confidence: true,
  reportedSeverity: true,
  firstSeenScanId: true,
  dedupeOfId: true,
} as const;

// Everything the base scan still considered live — active and suppressed,
// both sources. RESOLVED rows are history and are not carried again.
export function loadBaseFindings(
  prisma: Reader,
  baseScanId: string,
  source?: FindingSource,
): Promise<StoredFinding[]> {
  return prisma.finding.findMany({
    where: {
      scanId: baseScanId,
      status: { not: FindingStatus.RESOLVED },
      ...(source ? { source } : {}),
    },
    select: STORED_FINDING_SELECT,
  });
}

// RESOLVED rows of the PR's last REOPEN_WINDOW_SCANS finished scans before
// this one, plus this scan's own (written by the static step, read by the
// AI step) — the pool a candidate may re-open.
//
// `excludeCurrentSource` leaves out this scan's own RESOLVED rows of one
// source — the AI step in a FULL scan rewrites its RESOLVED rows on every
// run, so it must not point a REOPENED row at one it is about to delete.
export async function loadRecentResolved(
  prisma: Reader,
  pullId: string,
  currentScanId: string,
  excludeCurrentSource?: FindingSource,
): Promise<{ rows: StoredFinding[]; windowScanIds: string[] }> {
  const recent = await prisma.scan.findMany({
    where: {
      pullId,
      status: ScanStatus.DONE,
      id: { not: currentScanId },
    },
    orderBy: { createdAt: 'desc' },
    take: REOPEN_WINDOW_SCANS,
    select: { id: true },
  });
  const windowScanIds = recent.map((scan) => scan.id);
  const rows = await prisma.finding.findMany({
    where: {
      status: FindingStatus.RESOLVED,
      OR: [
        { scanId: { in: windowScanIds } },
        {
          scanId: currentScanId,
          ...(excludeCurrentSource
            ? { source: { not: excludeCurrentSource } }
            : {}),
        },
      ],
    },
    select: STORED_FINDING_SELECT,
  });
  return { rows, windowScanIds };
}

// A NEW finding whose fingerprint was resolved longer ago than the reopen
// window: not re-opened by design, but worth seeing in the logs.
export async function logWindowMisses(
  prisma: Reader,
  logger: Logger,
  params: {
    pullId: string;
    currentScanId: string;
    windowScanIds: string[];
    fingerprints: string[];
  },
  log: Record<string, unknown>,
): Promise<void> {
  if (params.fingerprints.length === 0) {
    return;
  }
  const older = await prisma.finding.findMany({
    where: {
      pullId: params.pullId,
      status: FindingStatus.RESOLVED,
      fingerprint: { in: params.fingerprints },
      scanId: { notIn: [...params.windowScanIds, params.currentScanId] },
    },
    select: { fingerprint: true, scanId: true },
    distinct: ['fingerprint'],
  });
  for (const miss of older) {
    logger.info('lifecycle.window_miss', {
      ...log,
      fingerprint: miss.fingerprint,
      resolvedInScanId: miss.scanId,
    });
  }
}
