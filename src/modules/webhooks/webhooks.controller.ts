import {
  Controller,
  Inject,
  Post,
  Req,
  Res,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { WebhooksService } from './webhooks.service';

// Global route, deliberately unguarded (no @OrgAuth/AuthGuard('jwt')) —
// mirrors GithubInstallationCallbackController: the caller here is
// GitLab's/GitHub's own server, not a browser with a session cookie, so
// org context can't come from a JWT and is instead resolved from the
// Repository row matched inside WebhooksService.
//
// Always responds 200, regardless of what happened processing the event —
// GitLab and GitHub both use the response status to decide whether to
// retry, and repeated non-2xx responses can get a webhook auto-disabled.
// The response body carries no information either provider reads.
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
    try {
      if (req.rawBody) {
        await this.webhooksService.handleGitlabEvent(req.rawBody, req.headers);
      } else {
        // Logged rather than silently skipped: without this branch a
        // delivery that arrives with no raw body is indistinguishable in
        // the logs from one that never reached this server at all, since
        // the 200 below is sent either way. rawBody is populated by
        // NestFactory's `rawBody: true` (main.ts) and is missing when the
        // request carries no body, or a Content-Type the body parser does
        // not handle.
        this.logger.warn('webhook.gitlab.no_raw_body', {
          contentType: req.headers['content-type'],
          contentLength: req.headers['content-length'],
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('webhook.gitlab.processing_error', { error: message });
    }
    res.status(200).send();
  }

  @Post('github')
  async github(
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ): Promise<void> {
    try {
      if (req.rawBody) {
        await this.webhooksService.handleGithubEvent(req.rawBody, req.headers);
      } else {
        // See the GitLab handler above for why this branch logs.
        this.logger.warn('webhook.github.no_raw_body', {
          contentType: req.headers['content-type'],
          contentLength: req.headers['content-length'],
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('webhook.github.processing_error', { error: message });
    }
    res.status(200).send();
  }
}
