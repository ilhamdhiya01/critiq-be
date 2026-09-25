import {
  Controller,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { WebhookOutcome, WebhooksService } from './webhooks.service';

// Global route, deliberately unguarded (no @OrgAuth/AuthGuard('jwt')) —
// mirrors GithubInstallationCallbackController: the caller here is
// GitLab's/GitHub's own server, not a browser with a session cookie, so
// org context can't come from a JWT and is instead resolved from the
// Repository row matched inside WebhooksService.
//
// Status codes: 401 only when the sender could not be authenticated (bad
// signature/token, or a GitLab repo whose secret we don't hold); 202 when a
// new scan job was enqueued; 200 for everything else — duplicates,
// out-of-scope branches, ignored events, and even unexpected processing
// errors. Both providers retry and can auto-disable a webhook on repeated
// non-2xx, so a failure that isn't the sender's fault must never surface
// as one; an authentication failure should, since that hook is broken.
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly webhooksService: WebhooksService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  @Post('gitlab')
  async gitlab(
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ): Promise<void> {
    await this.handle('gitlab', req, res, (rawBody) =>
      this.webhooksService.handleGitlabEvent(rawBody, req.headers),
    );
  }

  @Post('github')
  async github(
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ): Promise<void> {
    await this.handle('github', req, res, (rawBody) =>
      this.webhooksService.handleGithubEvent(rawBody, req.headers),
    );
  }

  private async handle(
    provider: 'gitlab' | 'github',
    req: RawBodyRequest<Request>,
    res: Response,
    run: (rawBody: Buffer) => Promise<WebhookOutcome>,
  ): Promise<void> {
    if (!req.rawBody) {
      // Logged rather than silently skipped: without this a delivery that
      // arrives with no raw body is indistinguishable in the logs from one
      // that never reached this server. rawBody is populated by
      // NestFactory's `rawBody: true` (main.ts) and is missing when the
      // request has no body or a Content-Type the body parser doesn't handle.
      this.logger.warn(`webhook.${provider}.no_raw_body`, {
        contentType: req.headers['content-type'],
        contentLength: req.headers['content-length'],
      });
      res.status(HttpStatus.OK).json({ received: true, skipped: 'malformed' });
      return;
    }

    let outcome: WebhookOutcome;
    try {
      outcome = await run(req.rawBody);
    } catch (error) {
      this.logger.error(`webhook.${provider}.processing_error`, {
        errorName: error instanceof Error ? error.name : 'Unknown',
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(HttpStatus.OK).json({ received: true });
      return;
    }

    switch (outcome.kind) {
      case 'rejected':
        res.status(HttpStatus.UNAUTHORIZED).json({ received: false });
        return;
      case 'duplicate':
        res.status(HttpStatus.OK).json({ received: true, duplicate: true });
        return;
      case 'skipped':
        res
          .status(HttpStatus.OK)
          .json({ received: true, skipped: outcome.reason });
        return;
      case 'pull_closed':
        res.status(HttpStatus.OK).json({ received: true });
        return;
      case 'scan_enqueued':
        // 202 only when this delivery actually created work; a repeat for
        // an already-scanned sha points at the existing scan with 200.
        res
          .status(outcome.deduplicated ? HttpStatus.OK : HttpStatus.ACCEPTED)
          .json({
            received: true,
            scanId: outcome.scanId,
            ...(outcome.deduplicated ? { deduplicated: true } : {}),
          });
        return;
    }
  }
}
