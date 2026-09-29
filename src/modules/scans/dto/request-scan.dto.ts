import { IsBoolean, IsOptional } from 'class-validator';

// POST …/pulls/:id/scans. Without `full`, a rescan is incremental: only
// what changed since the last finished scan (v1.5.1 langkah 3).
export class RequestScanDto {
  @IsOptional()
  @IsBoolean()
  full?: boolean;
}
