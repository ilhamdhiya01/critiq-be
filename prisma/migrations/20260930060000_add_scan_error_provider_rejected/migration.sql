-- A provider refusing a request as malformed (HTTP 400) — e.g. GitLab
-- merge_base answering "Provide at least 2 refs" — fails the scan at once
-- instead of being retried and reported as PROVIDER_UNREACHABLE.
ALTER TYPE "ScanErrorCode" ADD VALUE 'PROVIDER_REJECTED' AFTER 'PROVIDER_UNREACHABLE';
