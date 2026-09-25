import { HttpException } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { ScanErrorCode } from '../generated/prisma/enums';

// Thrown for failures that retrying cannot fix (diff too large, credential
// rejected, job deadline hit, every rule crashed). Extending BullMQ's
// UnrecoverableError makes BullMQ move the job straight to failed without
// spending the remaining attempts; ScanProcessor's failed handler reads
// `code` to persist Scan.errorCode.
export class ScanFailure extends UnrecoverableError {
  constructor(
    readonly code: ScanErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ProviderErrorKind = 'credential' | 'retryable' | 'unknown';

// GithubAppService/GitlabApiService/PullsService.getDiff never surface raw
// HTTP statuses — they map everything to Nest HttpExceptions whose
// response body carries a stable `message` code. Classify on that code.
export function classifyProviderError(error: unknown): ProviderErrorKind {
  if (!(error instanceof HttpException)) {
    return 'unknown';
  }
  const response = error.getResponse();
  const code =
    typeof response === 'object' && response !== null && 'message' in response
      ? response.message
      : undefined;

  switch (code) {
    // installation_invalid also covers a GitHub 404 — the PR/repo being
    // gone looks identical to a revoked installation from this call, and
    // neither is fixed by retrying.
    case 'installation_invalid':
    case 'token_invalid':
    case 'token_expired':
      return 'credential';
    case 'provider_unreachable':
    case 'github_unreachable':
    case 'instance_unreachable':
      return 'retryable';
    default:
      return 'unknown';
  }
}

const TOKEN_SHAPED_PATTERN =
  /(gh[pousr]_[A-Za-z0-9]+|glpat-[A-Za-z0-9_-]+|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+|bearer\s+\S+)/gi;

const MAX_ERROR_MESSAGE_LENGTH = 500;

// Scan.errorMessage is shown to every org member — strip anything shaped
// like a credential and cap the length before persisting.
export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(TOKEN_SHAPED_PATTERN, '[redacted]')
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
}
