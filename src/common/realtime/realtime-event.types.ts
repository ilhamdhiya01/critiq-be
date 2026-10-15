import type {
  AiScanStatus,
  IntegrationState,
  Provider,
  PullRequestState,
  ReviewSyncStatus,
  ScanStatus,
} from '../../generated/prisma/enums';

// Realtime events (SSE, outside the PRD — CLAUDE.md "Realtime (SSE)").
// An event is an invalidation hint: ids and statuses only, so the client
// refetches over REST and tenant isolation, roles and DTO shapes stay where
// they already are. Never put comment bodies, code, provider messages or
// tokens here — the payload reaches every member of the organization.

export type CommentChange =
  'created' | 'edited' | 'deleted' | 'sync_pending' | 'synced' | 'sync_failed';

export type RepoChange =
  'connected' | 'scan_config_updated' | 'language_detected';

export type SettingsArea = 'ai' | 'rules' | 'organization';

// What a caller hands the publisher: Prisma enum values as they are in the
// code. The publisher lowercases them for the wire, the same spelling REST
// uses.
export type RealtimeEventInput =
  | {
      type: 'scan.updated';
      orgId: string;
      repoId: string;
      pullId: string;
      scanId: string;
      status: ScanStatus;
      aiStatus: AiScanStatus | null;
    }
  | {
      type: 'pull.updated';
      orgId: string;
      repoId: string;
      pullId: string;
      state: PullRequestState;
      headChanged: boolean;
    }
  | {
      type: 'review.updated';
      orgId: string;
      repoId: string;
      pullId: string;
      reviewId: string;
      syncStatus: ReviewSyncStatus;
    }
  | {
      type: 'comment.updated';
      orgId: string;
      repoId: string;
      pullId: string;
      commentId: string;
      change: CommentChange;
    }
  | {
      type: 'integration.updated';
      orgId: string;
      source: Provider;
      state: IntegrationState | 'DISCONNECTED';
    }
  | {
      type: 'repo.updated';
      orgId: string;
      repoId: string;
      change: RepoChange;
    }
  | {
      type: 'settings.updated';
      orgId: string;
      area: SettingsArea;
    };

export type RealtimeEventType = RealtimeEventInput['type'];

// What travels over Redis and the SSE stream: the input with enum values
// lowercased, plus an id and a timestamp.
export interface RealtimeWireEvent {
  id: string;
  type: RealtimeEventType;
  orgId: string;
  at: string;
  [field: string]: unknown;
}

// One Redis channel per organization: an app instance only forwards an
// event to streams opened for the org in the channel name.
export const REALTIME_CHANNEL_PREFIX = 'critiq:events:org:';

export const realtimeChannel = (orgId: string) =>
  `${REALTIME_CHANNEL_PREFIX}${orgId}`;
